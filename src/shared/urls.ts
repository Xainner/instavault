/** URL del protocolo privado para un archivo del almacén. */
export const assetUrl = (sha: string | null | undefined): string | null =>
  sha ? `vault://a/${sha}` : null;

export const instagramPostUrl = (code: string) => `https://www.instagram.com/p/${code}/`;
export const instagramProfileUrl = (username: string) => `https://www.instagram.com/${username}/`;
