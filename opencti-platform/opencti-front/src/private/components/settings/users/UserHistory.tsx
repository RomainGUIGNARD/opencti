import React, { FunctionComponent, useEffect, useState } from 'react';
import Typography from '@mui/material/Typography';
import { useQueryLoader } from 'react-relay';
import { LogsOrdering, OrderingMode, UserHistoryLinesQuery } from '@components/settings/users/__generated__/UserHistoryLinesQuery.graphql';
import Tooltip from '@mui/material/Tooltip';
import IconButton from '@mui/material/IconButton';
import VisibilityOutlinedIcon from '@mui/icons-material/VisibilityOutlined';
import PolylineOutlinedIcon from '@mui/icons-material/PolylineOutlined';
import { Link } from 'react-router-dom';
import { GqlFilterGroup } from '../../../../utils/filters/filtersUtils';
import { useFormatter } from '../../../../components/i18n';
import Loader, { LoaderVariant } from '../../../../components/Loader';
import SearchInput from '../../../../components/SearchInput';
import UserHistoryLines, { userHistoryLinesQuery } from './UserHistoryLines';

const createdByUserRedirectButton = {
  float: 'left',
  marginTop: '-15px',
};

interface UserHistoryProps {
  userId: string,
}

const UserHistory: FunctionComponent<UserHistoryProps> = ({
  userId,
}) => {
  const { t } = useFormatter();
  const [entitySearchTerm, setEntitySearchTerm] = useState<string>('');

  const handleSearchEntity = (value: string) => {
    setEntitySearchTerm(value);
  };

  const [queryRef, loadQuery] = useQueryLoader<UserHistoryLinesQuery>(userHistoryLinesQuery);
  const queryArgs = {
    filters: {
      mode: 'and',
      filterGroups: [],
      filters: [
        { key: ['user_id'], values: [userId], operator: 'wildcard', mode: 'or' },
        {
          key: ['event_type'],
          values: ['mutation', 'create', 'update', 'delete', 'merge'],
          operator: 'eq',
          mode: 'or',
        },
      ],
    } as GqlFilterGroup,
    first: 10,
    orderBy: 'timestamp' as LogsOrdering,
    orderMode: 'desc' as OrderingMode,
    search: entitySearchTerm,
  };

  // Entities and relationships redirection filters
  const technicalCreatorFilters = JSON.stringify({
    mode: 'and',
    filterGroups: [],
    filters: [
      {
        key: 'creator_id',
        values: [
          userId,
        ],
        operator: 'eq',
        mode: 'or',
      },
    ],
  });

  useEffect(() => {
    loadQuery(queryArgs, { fetchPolicy: 'store-and-network' });
  }, []);

  const refetch = React.useCallback(() => {
    loadQuery(queryArgs, { fetchPolicy: 'store-and-network' });
  }, [queryRef]);

  return (
    <>
      <Typography variant="h4" gutterBottom={true} style={{ float: 'left' }}>
        {t('History')}
      </Typography>
      <div style={{ float: 'right', marginTop: -12 }}>
        <SearchInput
          variant="thin"
          onSubmit={handleSearchEntity}
          keyword={entitySearchTerm}
        />
      </div>
      <Tooltip title={t('See all entities created by user')}>
        <IconButton
          sx={createdByUserRedirectButton}
          component={Link}
          to={`/dashboard/search/knowledge/?filters=${encodeURIComponent(technicalCreatorFilters)}`}
          size="large"
          color="secondary"
        >
          <VisibilityOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={t('See all relationships created by user')}>
        <IconButton
          sx={createdByUserRedirectButton}
          component={Link}
          to={`/dashboard/data/relationships/?filters=${encodeURIComponent(technicalCreatorFilters)}`}
          size="large"
          color="secondary"
        >
          <PolylineOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <div className="clearfix" />
      {queryRef ? (
        <React.Suspense fallback={<Loader variant={LoaderVariant.container} />}>
          <UserHistoryLines
            queryRef={queryRef}
            isRelationLog={false}
            refetch={refetch}
          />
        </React.Suspense>
      ) : (
        <Loader variant={LoaderVariant.container} />
      )}
    </>
  );
};

export default UserHistory;
