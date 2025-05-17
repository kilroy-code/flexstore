const tagBreakup = /(\S{10})(\S{2})(\S{2})(\S+)/;

// Utilities to break up tag into directories, and to re-assemble a path back into a tag.
// We break up tags for two reasons:
// 1. Load balancer rules can easily put different tags on different machines.
// 2. File systems do not end up with too much in a single directory.
//
// If tags are hashes, then all the bits are equally random. However, if the
// tag is is, e.g., a base64 encoding of JSON, then the bits at the start and end are not random.
// Therefore, we begin our path with pairs of characters out of the middle.

export function tagPath(base, tag, extension = '') { // Pathname to tag resource.
  let match = tag.match(tagBreakup);
  // eslint-disable-next-line no-unused-vars
  let [_, a, b, c, rest] = match;
  return `${base}/${b}/${c}/${a}/${rest}${extension}`;
}

export function pathTag(req, res, next) { // Middleware to invert tagPath - i.e., set the tag from the path components
  let {a, b, c, rest} = req.params;
  req.params.tag = a+b+c+rest;
  next();
}

