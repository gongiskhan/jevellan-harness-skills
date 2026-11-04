// A credential never leaves the server in full: the browser sees its last four characters.
export function maskCredential(credential) {
  if (!credential) return null;
  return `••••${String(credential).slice(-4)}`;
}

export function publicRow(row) {
  return { ...row, credential: maskCredential(row.credential) };
}
