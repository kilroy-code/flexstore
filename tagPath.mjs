export function tagPath(base, tag, extension = '') { // Pathname to tag resource.
  return `${base}/${tag}${extension}`;
}

export function basePath(dbName, collectionType, collectionName) {
  return `${dbName}/${collectionType}/${collectionName}`;
}
