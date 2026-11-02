/** An rclone remote path such as `gdrive-ro:Folder/passwords.kdbx`. Must not start with "-" (it would be read as an option). */
export const REMOTE_RE = /^[A-Za-z0-9_][A-Za-z0-9_.@+-]*:[^\0\r\n]+$/;
