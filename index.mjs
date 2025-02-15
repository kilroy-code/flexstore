import Credentials from '@ki1r0y/distributed-security';
import Synchronizer from './lib/synchronizer.mjs';
import { ImmutableCollection, MutableCollection, VersionedCollection } from  './lib/collections.mjs';

export { Credentials, ImmutableCollection, MutableCollection, VersionedCollection, Synchronizer };
export default { Credentials, ImmutableCollection, MutableCollection, VersionedCollection, Synchronizer };
Object.assign(globalThis, {Credentials, ImmutableCollection, MutableCollection, VersionedCollection}); // fixme remove
