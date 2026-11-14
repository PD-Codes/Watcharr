// The local emergency admin that /adminlogin creates when nobody holds the global admin role
// and the media server cannot be reached to sign anyone in. No media server ever reports this
// id, so the row can never be taken over by a real account. Pure, no 'server-only': both
// session.ts and setuptoken.ts need it, and neither may import the other's module graph.

export const RECOVERY_SERVER_USER_ID = 'watcharr:recovery';
export const RECOVERY_USERNAME = 'watcharr-admin';
