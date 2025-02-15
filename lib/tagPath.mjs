const tagBreakup = /(\S{10})(\S{2})(\S{2})(\S+)/;
export function tagPath(base, tag, extension = '') { // Pathname to tag resource.
  let match = tag.match(tagBreakup);
  // eslint-disable-next-line no-unused-vars
  let [_, a, b, c, rest] = match;
  return `${base}/${b}/${c}/${a}/${rest}${extension}`;
}

export function basePath(dbName, collectionType, collectionName) {
  return `${dbName}/${collectionType}/${collectionName}`;
}

export function pathTag(req, res, next) { // Middleware to invert tagPath - i.e., set the tag from the path components
  let {a, b, c, rest} = req.params;
  req.params.tag = a+b+c+rest;
  next();
}

