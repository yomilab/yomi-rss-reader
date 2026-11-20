import React, { useCallback } from 'react';

import { useFeedCollectionArticles, useFeedOverlay } from '@/contexts/FeedContext';
import { MiniPlayer } from './MiniPlayer';

/** Connects the mini player to the article deck in the main window. */
export const MiniPlayerHost: React.FC = () => {
  const { articles } = useFeedCollectionArticles();
  const { selectArticle } = useFeedOverlay();

  const canOpenArticle = useCallback(
    (hash: string) => articles.some((article) => article.hash === hash),
    [articles],
  );

  return (
    <MiniPlayer
      onOpenArticle={selectArticle}
      canOpenArticle={canOpenArticle}
    />
  );
};
