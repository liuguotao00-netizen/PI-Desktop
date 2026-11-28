// Versions are supplied by the running host snapshot, never inferred from data files.
export function versionLabel(info) {
  const valid = value => typeof value === 'string' && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(value);
  const version = info?.client === 'DSH' ? info.adapter : info?.knowledge;
  return valid(version) ? `v${version}` : '';
}
