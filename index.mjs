import Credentials from '@ki1r0y/distributed-security';
import uuid4 from 'uuid4';
import Synchronizer from './lib/synchronizer.mjs';
import { Collection, MutableCollection, ImmutableCollection, StateCollection, VersionedCollection, StorageLocal } from  './lib/collections.mjs';
import { WebRTC, PromiseWebRTC, SharedWebRTC } from './lib/webrtc.mjs';
import { version, name, storageVersion, storageName } from './lib/version.mjs';

console.log(`${name} ${version} from ${import.meta.url}.`);

export { Credentials, Collection, MutableCollection, ImmutableCollection, StateCollection, VersionedCollection, Synchronizer, WebRTC, PromiseWebRTC, SharedWebRTC, name, version, storageName, storageVersion, StorageLocal, uuid4 };
export default { Credentials, Collection, MutableCollection, ImmutableCollection, StateCollection, VersionedCollection, Synchronizer, WebRTC, PromiseWebRTC, SharedWebRTC, name, version,  storageName, storageVersion, StorageLocal, uuid4 };
