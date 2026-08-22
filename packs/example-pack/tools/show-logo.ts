import type { Handler } from 'aws-lambda';

/**
 * Example MCP tool that returns a UI spec for an image widget.
 */
export const handler: Handler = async () => {
  return {
    type: 'ui_spec',
    content: {
      type: 'image',
      data: {
        url: 'https://example.com/logo.png',
        alt: 'Example logo'
      }
    }
  };
};
