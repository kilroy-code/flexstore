// name/version of "database"
export const storageName = 'flexstore';
export const storageVersion = 8;

import * as pkg from "../package.json" with { type: 'json' };
export const {name, version} = pkg.default;
