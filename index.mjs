import Credentials from '@ki1r0y/distributed-security';
import Synchronizer from './lib/synchronizer.mjs';
import { Collection, ImmutableCollection, MutableCollection, VersionedCollection, VersionCollection } from  './lib/collections.mjs';
import { WebRTC, PromiseWebRTC, SharedWebRTC } from './lib/webrtc.mjs';
import { version, name, storageVersion, storageName } from './lib/version.mjs';

console.log(`${name} ${version} from ${import.meta.url}.`);

export { Credentials, Collection, ImmutableCollection, MutableCollection, VersionedCollection, VersionCollection, Synchronizer, WebRTC, PromiseWebRTC, SharedWebRTC, name, version, storageName, storageVersion };
export default { Credentials, Collection, ImmutableCollection, MutableCollection, VersionedCollection, VersionCollection, Synchronizer, WebRTC, PromiseWebRTC, SharedWebRTC, name, version,  storageName, storageVersion };
