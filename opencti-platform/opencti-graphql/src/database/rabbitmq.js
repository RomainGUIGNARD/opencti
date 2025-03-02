import amqp from 'amqplib/callback_api';
import util from 'util';
import { SemanticAttributes } from '@opentelemetry/semantic-conventions';
import conf, { booleanConf, configureCA, loadCert, logApp } from '../config/conf';
import { DatabaseError } from '../config/errors';
import { SYSTEM_USER } from '../utils/access';
import { telemetry } from '../config/tracing';
import { INTERNAL_PLAYBOOK_QUEUE, INTERNAL_SYNC_QUEUE, RABBIT_QUEUE_PREFIX } from './utils';
import { getHttpClient } from '../utils/http-client';

export const CONNECTOR_EXCHANGE = `${RABBIT_QUEUE_PREFIX}amqp.connector.exchange`;
export const WORKER_EXCHANGE = `${RABBIT_QUEUE_PREFIX}amqp.worker.exchange`;

const USE_SSL = booleanConf('rabbitmq:use_ssl', false);
const QUEUE_TYPE = conf.get('rabbitmq:queue_type');
const readFileFromConfig = (configKey) => (conf.get(configKey) ? loadCert(conf.get(configKey)) : undefined);
const RABBITMQ_CA = (conf.get('rabbitmq:use_ssl_ca') ?? []).map((path) => loadCert(path));
const RABBITMQ_CA_CERT = readFileFromConfig('rabbitmq:use_ssl_cert');
const RABBITMQ_CA_KEY = readFileFromConfig('rabbitmq:use_ssl_key');
const RABBITMQ_CA_PFX = readFileFromConfig('rabbitmq:use_ssl_pfx');
const RABBITMQ_CA_PASSPHRASE = conf.get('rabbitmq:use_ssl_passphrase');
const RABBITMQ_REJECT_UNAUTHORIZED = booleanConf('rabbitmq:use_ssl_reject_unauthorized', false);
const RABBITMQ_MGMT_REJECT_UNAUTHORIZED = booleanConf('rabbitmq:management_ssl_reject_unauthorized', false);
const HOSTNAME = conf.get('rabbitmq:hostname');
const PORT = conf.get('rabbitmq:port');
const USERNAME = conf.get('rabbitmq:username');
const PASSWORD = conf.get('rabbitmq:password');
const VHOST = conf.get('rabbitmq:vhost');
const VHOST_PATH = VHOST === '/' ? '' : `/${VHOST}`;
const USE_SSL_MGMT = booleanConf('rabbitmq:management_ssl', false);
const HOSTNAME_MGMT = conf.get('rabbitmq:hostname_management') || HOSTNAME;
const PORT_MGMT = conf.get('rabbitmq:port_management');

const amqpUri = () => {
  const ssl = USE_SSL ? 's' : '';
  return `amqp${ssl}://${HOSTNAME}:${PORT}${VHOST_PATH}`;
};

const amqpCred = () => {
  return { credentials: amqp.credentials.plain(USERNAME, PASSWORD) };
};

export const config = () => {
  return {
    host: HOSTNAME,
    vhost: VHOST,
    use_ssl: USE_SSL,
    port: PORT,
    user: USERNAME,
    pass: PASSWORD,
  };
};

const amqpExecute = async (execute) => {
  const connOptions = USE_SSL ? {
    ...amqpCred(),
    ...configureCA(RABBITMQ_CA),
    cert: RABBITMQ_CA_CERT,
    key: RABBITMQ_CA_KEY,
    pfx: RABBITMQ_CA_PFX,
    passphrase: RABBITMQ_CA_PASSPHRASE,
    rejectUnauthorized: RABBITMQ_REJECT_UNAUTHORIZED,
  } : amqpCred();
  return new Promise((resolve, reject) => {
    try {
      amqp.connect(amqpUri(), connOptions, (err, conn) => {
        if (err) {
          reject(err);
        } else { // Connection success
          conn.on('error', (onConnectError) => {
            reject(onConnectError);
          });
          conn.createConfirmChannel((channelError, channel) => {
            if (channelError) {
              reject(channelError);
            } else {
              channel.on('error', (onChannelError) => {
                reject(onChannelError);
              });
              execute(channel).then((data) => {
                channel.close();
                conn.close();
                resolve(data);
              }).catch((executeError) => reject(executeError));
            }
          });
        }
      });
    } catch (globalError) {
      reject(globalError);
    }
  });
};

export const send = (exchangeName, routingKey, message) => {
  return amqpExecute(async (channel) => {
    const publish = util.promisify(channel.publish).bind(channel);
    return publish(exchangeName, routingKey, Buffer.from(message), { deliveryMode: 2 });
  });
};

export const metrics = async (context, user) => {
  const metricApi = async () => {
    const ssl = USE_SSL_MGMT ? 's' : '';
    const baseURL = `http${ssl}://${HOSTNAME_MGMT}:${PORT_MGMT}`;
    const httpClient = getHttpClient({
      baseURL,
      responseType: 'json',
      rejectUnauthorized: RABBITMQ_MGMT_REJECT_UNAUTHORIZED,
      auth: {
        username: USERNAME,
        password: PASSWORD,
      },
    });
    const overview = await httpClient.get('/api/overview').then((response) => response.data);
    const queues = await httpClient.get(`/api/queues${VHOST_PATH}`).then((response) => response.data);
    // Compute number of push queues
    const platformQueues = queues.filter((q) => q.name.startsWith(RABBIT_QUEUE_PREFIX));
    const pushQueues = platformQueues.filter((q) => q.name.startsWith(`${RABBIT_QUEUE_PREFIX}push_`) && q.consumers > 0);
    const consumers = pushQueues.length > 0 ? pushQueues[0].consumers : 0;
    return { overview, consumers, queues: platformQueues };
  };
  return telemetry(context, user, 'QUEUE metrics', {
    [SemanticAttributes.DB_NAME]: 'messaging_engine',
    [SemanticAttributes.DB_OPERATION]: 'metrics',
  }, metricApi);
};

export const connectorConfig = (id) => ({
  connection: config(),
  push: `${RABBIT_QUEUE_PREFIX}push_${id}`,
  push_routing: pushRouting(id),
  push_exchange: WORKER_EXCHANGE,
  listen: `${RABBIT_QUEUE_PREFIX}listen_${id}`,
  listen_routing: listenRouting(id),
  listen_exchange: CONNECTOR_EXCHANGE,
});

export const listenRouting = (connectorId) => `${RABBIT_QUEUE_PREFIX}listen_routing_${connectorId}`;

export const pushRouting = (connectorId) => `${RABBIT_QUEUE_PREFIX}push_routing_${connectorId}`;

export const registerConnectorQueues = async (id, name, type, scope) => {
  const listenQueue = `${RABBIT_QUEUE_PREFIX}listen_${id}`;
  const pushQueue = `${RABBIT_QUEUE_PREFIX}push_${id}`;
  await amqpExecute(async (channel) => {
    // 01. Ensure exchange exists
    const assertExchange = util.promisify(channel.assertExchange).bind(channel);
    await assertExchange(CONNECTOR_EXCHANGE, 'direct', { durable: true });
    await assertExchange(WORKER_EXCHANGE, 'direct', { durable: true });
    // 02. Ensure listen queue exists
    const assertQueue = util.promisify(channel.assertQueue).bind(channel);
    await assertQueue(listenQueue, {
      exclusive: false,
      durable: true,
      autoDelete: false,
      arguments: { name, config: { id, type, scope }, 'x-queue-type': QUEUE_TYPE },
    });
    // 03. bind queue for each connector scope
    const bindQueue = util.promisify(channel.bindQueue).bind(channel);
    await bindQueue(listenQueue, CONNECTOR_EXCHANGE, listenRouting(id), {});
    // 04. Create stix push queue
    await assertQueue(pushQueue, {
      exclusive: false,
      durable: true,
      autoDelete: false,
      arguments: { name, config: { id, type, scope }, 'x-queue-type': QUEUE_TYPE },
    });
    // 05. Bind push queue to direct default exchange
    await bindQueue(pushQueue, WORKER_EXCHANGE, pushRouting(id), {});
    return true;
  });
  return connectorConfig(id);
};

export const unregisterConnector = async (id) => {
  const listen = await amqpExecute(async (channel) => {
    const deleteQueue = util.promisify(channel.deleteQueue).bind(channel);
    return deleteQueue(`${RABBIT_QUEUE_PREFIX}listen_${id}`, {});
  });
  const push = await amqpExecute(async (channel) => {
    const deleteQueue = util.promisify(channel.deleteQueue).bind(channel);
    return deleteQueue(`${RABBIT_QUEUE_PREFIX}push_${id}`, {});
  });
  return { listen, push };
};

export const unregisterExchanges = async () => {
  await amqpExecute(async (channel) => {
    const deleteExchange = util.promisify(channel.deleteExchange).bind(channel);
    return deleteExchange(CONNECTOR_EXCHANGE, {});
  });
  await amqpExecute(async (channel) => {
    const deleteExchange = util.promisify(channel.deleteExchange).bind(channel);
    return deleteExchange(WORKER_EXCHANGE, {});
  });
};

export const rabbitMQIsAlive = async () => {
  return amqpExecute(async (channel) => {
    const assertExchange = util.promisify(channel.assertExchange).bind(channel);
    return assertExchange(CONNECTOR_EXCHANGE, 'direct', { durable: true });
  }).catch(
    /* v8 ignore next */ (e) => {
      throw DatabaseError('RabbitMQ seems down', { error: e.data });
    }
  );
};

export const pushToSync = (message) => {
  return send(WORKER_EXCHANGE, pushRouting(INTERNAL_SYNC_QUEUE), JSON.stringify(message));
};

export const pushToPlaybook = (message) => {
  return send(WORKER_EXCHANGE, pushRouting(INTERNAL_PLAYBOOK_QUEUE), JSON.stringify(message));
};

export const pushToConnector = (connectorId, message) => {
  return send(CONNECTOR_EXCHANGE, listenRouting(connectorId), JSON.stringify(message));
};

export const getRabbitMQVersion = (context) => {
  return metrics(context, SYSTEM_USER)
    .then((data) => data.overview.rabbitmq_version)
    .catch(/* v8 ignore next */ () => 'Disconnected');
};

export const consumeQueue = async (context, connectorId, connectionSetterCallback, callback) => {
  const cfg = connectorConfig(connectorId);
  const listenQueue = cfg.listen;
  const connOptions = USE_SSL ? {
    ...amqpCred(),
    ...configureCA(RABBITMQ_CA),
    cert: RABBITMQ_CA_CERT,
    key: RABBITMQ_CA_KEY,
    pfx: RABBITMQ_CA_PFX,
    passphrase: RABBITMQ_CA_PASSPHRASE,
    rejectUnauthorized: RABBITMQ_REJECT_UNAUTHORIZED,
  } : amqpCred();
  return new Promise((_, reject) => {
    try {
      amqp.connect(amqpUri(), connOptions, (err, conn) => {
        if (err) {
          reject(err);
        } else { // Connection success
          logApp.info('Starting connector queue consuming');
          conn.on('error', (onConnectError) => {
            reject(onConnectError);
          });
          connectionSetterCallback(conn);
          conn.createChannel((channelError, channel) => {
            if (channelError) {
              reject(channelError);
            } else {
              channel.on('error', (onChannelError) => {
                reject(onChannelError);
              });
              channel.consume(listenQueue, (data) => {
                if (data !== null) {
                  callback(context, data.content.toString());
                }
              }, { noAck: true }, (consumeError) => {
                if (consumeError) {
                  logApp.error('CONNECTOR_CONSUMER_QUEUE_CONSUME', { error: consumeError });
                }
              });
            }
          });
        }
      });
    } catch (globalError) {
      reject(globalError);
    }
  });
};
