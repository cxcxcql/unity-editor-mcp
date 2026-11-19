export const searchPageGuidance =
  'Returns one page. Keep the same search filters and pass nextOffset as offset until hasMore is false. ' +
  'If the scene or prefab assets change between pages, restart with offset=0. ' +
  'A page may be shorter than limit to fit the response. An item with truncated=true provides its identity only.';

export const searchPageProperties = {
  offset: {
    type: 'integer',
    minimum: 0,
    maximum: 2147483647,
    default: 0,
    description: 'Zero-based offset; use nextOffset from the previous page.'
  },
  limit: {
    type: 'integer',
    minimum: 1,
    maximum: 1000,
    default: 100,
    description: 'Maximum matches to return in this page.'
  }
};

export function assertSearchPagination(args, result) {
  if ((args.offset !== undefined || args.limit !== undefined) && typeof result?.hasMore !== 'boolean') {
    const error = new Error('Unity MCP plugin did not return pagination metadata. Update the Unity plugin before requesting pages.');
    error.code = 'UNITY_PAGINATION_UNSUPPORTED';
    throw error;
  }
}
