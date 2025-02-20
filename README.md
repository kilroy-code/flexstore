# Flexstore

**STATUS**

**Done:** Tests [here](https://github.com/kilroy-code/flexstore/tree/main/spec) and [there](https://github.com/kilroy-code/distributed-security/tree/main/spec) show that:
- Content is signed and encrypted for its owning group.
- Content is persisted locally and shared in real time (i.e., "pushed") with any peer to which you are connected.
- Content can be securely relayed through untrusted peers, either asynchronously or in real time.
- Cryptographic keys for signing and encrypting are securely held as relayable content.

**Next:**
- Show that content can be relayed (asynchronously and realtime) through multiple servers.

---

Flexstore lets you easily and safely set up a key-value JSON collection in an app, which _also_ lets you work offline, federate the storage across relay servers, and even p2p between browser clients:

1. Each collection can be independently and dynamically connected to any number of peer clients or relay servers. While connected, all changes are automatically shared in realtime (even as full replication of the collection continues in the background).
2. Each collection can later be synchronized with any number of peer clients or relay servers, with the collection automatically merged and reconciled.

The relays (whether servers or clients) do not need to cooperate with or know anything about your app.

It is a very simple (and secure!) way to have shared, authenticated, live data in an app that works online or offline:

- Everything is signed so that wherever the data is stored, you can be sure who saved it and that it has not since been modified.
- Data is optionally encrypted, so that it can  be read only by the intended audience.
- The cryptographic keys are safely stored in the system itself (signed and encrypted) so that they are available from the cloud to your users' devices. The keys are user-managed, and there are no custodial copies -- i.e., even you do not have access.

This package works in browsers and in NodeJS. However, the documented, standards-based protocol can be implemented in any implementation that supports the underlying [JWS](https://datatracker.ietf.org/doc/html/rfc7515) and [JWE](https://www.rfc-editor.org/rfc/rfc7516), and web transports. (The current version supports HTTPS REST, and peer/realtime push through [WRTC](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API) [data channels](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels). Future implementations are likely to also support websockets for realtime push, and allow automatic archiving of older data that gets pulled in from a relay server on-demand.)

See also the [API](https://github.com/kilroy-code/flexstore/blob/main/docs/api.md) (under construction) and the [Limitations, Risks and Mitigations](https://github.com/kilroy-code/flexstore/blob/main/docs/risks.md).

## Installation

```
npm install @ki1r0y/flexstore
```

flexstore includes @ki1r0y/distributed-security as a dependency, which provides some [additional files](https://github.com/kilroy-code/distributed-security/blob/main/README.md#application-use) that must be served from the same https directory.


## Examples

### App Setup:

```
import { Credentials, MutableCollection, ImmutableCollection, VersionedCollection } 
   from '@ki1r0y/flexstore';

// An app can have several Collections, with different sets of online services.
const services = ['/', 'https://sharedCloud.org/flex/'];

// Start synchronizing the app's collections with each of the reachable services.
const media = new ImmutableCollection({name: 'com.acme.media, services});

const users = new MutableCollection({name: 'com.acme.users, services});
const groups = new MutableCollection({name: 'com.acme.groups, services});

const messages = new VersionedCollection({name: 'com.acme.messages, services});

groups.addEventListener('update', groupChanged);
messages.addEventListener('update', newMessage);

// There are some internal collections for credentials. Synchronize those, too.
Credentials.synchronize(services); // No need to await the end of synchronization.

const currentUser = setupCurrentUser(); // See below. 
```

In this example, the app synchronizes all users, groups, messages, and media -- not just the ones that the user is interested in.
A stand-alone relay would probably do that, while a mobile client app would probably be more selective. 
Collections can be as specialized as the app needs them to be. E.g., instead of "messages" for all groups, an app could make an "my-group-ledger" collection, that has various kinds of items (e.g., message, iou, vote, ...).


### Dynamic Sync:

Apps do not have to stay synchronized. One can also just exchange data, which in this case is another client peer:

```
const peerSession = "some agreed upon name that does not start with http, /, or ./";
await messages.synchronize(peerSession);
users.disconnect(peerSession);
```

### Operations:

```
Credentials.author = currentUser; // Must be given to each store(), or set here as default.

const myData = {name: 'Alice', birthday: '01/01'};
await users.store(myData, currentUser);
const allUsers = await users.list();

function groupChanged(signature, tag) {
  console.log(`Group tag ${tag} updated to ${signature.json} at ${new Date(signature.time)}`);
}
// Above prints raw group json and group tag - a 132-byte base64 string.
// A more realistic example might read the referenced data:
function newMessage(messageSignature, tag) {
  const messageData = messageSignature.json; // Can also be .text or binary .payload.
  const mediaSignature = await media.retieve(messagageData.attachment);
  const senderSignature = await users.retrieve(messageSignature.author);
  const groupSignature = await groups.retieve(messageSignature.owner);
  appSpecificUpdateMessageDisplay(messageSignature.text, 
                                  senderSignature.json.name, 
                                  groupSignature.json.name
                                  mediaData.payload);
}
```


### Write Permissions

In the operations above, only the `Credentials.author` has beeen set, and not a `Credentials.owner`. In this case, only the author will be able to `store()` new data or `remove()` it (for any mutable collection).

We can arrange for any one of an enumerated team of users to be able to make changes, by specifying an `owner` in addition to the `author`.

```
const teamAlice = Credentials.create(currentUser, someOtherUserTag, yetAnotherUserTag);
Credentials.owner = teamAlice; // New items stored will be readable only by teamAlice.
// teamAlice membership can be changed later, without effecting signatures/encryption!

// We can use this tag in other data, and as tags in MutableCollections.
// Here we use the named-argument form of store().
const groupData = {name: 'Team Alice', description: 'Whatever'};
await groups.store({data: groupData, tag: teamAlice}); // Credentials.owner default.
userData.group = teamAlice;
await users.store(data: userData, tag: currentUser, owner: currentUser});//override default
```

A user can be on any number of owner teams, and teams can have other teams as members. In a distributed system (and arguably in all systems), this way of specifying ownership is more flexible than trying to maintain a set of "write permissions" via an access control list. 


### Encryption
 
We can also arrange for only the members of a tag to be able to _read_ the data. This is done by encrypting the data on the client before it is signed, and decrypting it on the client after it is verfied. 

```
store({data, encryption: true}); // For owner (or default author).
store({data, encryption: tag}); // Members of tag can read.
// The Credentials.author does NOT have be a members of tag to write, only to read!

Credentials.encryption = true; // Set up a default for above.
```

### Credentials Setup

These few lines both cover and ignore a lot of complexity.

```
// Return tag of returning user. If none, add existing user to here, or create one.
function setupCurrentUser() { 
  // In a browser. 
  let tag = localStorage.getItem('existingTag'); // From last time, if any.

  // Always return the same secret for the same user tag and optional promptString.
  function getUserSecret(tag, promptString = '') { 
    function swizzle(seed) { return seed + 'appSalt'; } // Could look in a customer db.
    if (prompt) return swizzle(prompt(promptString)); // Ask user for a secret!
    return swizzle(tag);
  };
  Credentials.getUserDeviceSecret = getUserSecret; // Required setup.

  // We need a valid credential to sign store() or remove() requests:
  
  if (!tag) { // If there isn't a tag from last time...
    const username = prompt("Your existing username? Blank for none.");
    let existingAuthor = username && await users.find({name: username});
    // If username provided and it exists, try to authorize it on this machine:
    if (existingAuthor) { 
      // ...which will call Credentials.getUserDeviceSecret and check the answer.
      await Credentials.authorizeAuthor(existingAuthor).catch(_ => existingAuthor = null);
    }
    if (!existingAuthor) { // Wasn't entered, found, or matched.
      // Create one, which will call Credentials.getUserDeviceSecret and save the response.
      existingAuthor = await Credentials.createAuthor({prompt: "Enter a pin:"});
    }
    localStorage.setItem('existingTag', tag); // Save for next time.
  }
  return tag;
}
```


## Pseudonymity

`author` and `owner` tags are stable base64 strings that may or may not correspond to distinct individuals or groups. This protocol does not provide any central collection of users, but applications may do so for their users, and such applications might or might not include attestations as to human identities signed by some authority. An individual human or group of people may create different tags for different applications, multiple tags within an application, or may re-use a tag at their (and the application's) discretion.

An application can allow (or require) a user to encrypt data within a collection - the whole item, or particular property values. Additionaly, an application may synchronize only with its own service, or may choose to relay data with other services, and this includes the [`Team`](#key-management) collection. However, the membership tags of an `owner` group are readable by anyone who has access to the collection!

## Synchronization

All collections start synchronizing their listed services at construction, and will stay connected until `disconnect()`. (Of source, the services list can be empty.) Services can later be added explicitly with the `synchronize()` method.

While we are connected, any `store()` or `remove()` calls on either system are forwarded to the other. (These internally forwarded calls are not transitively forwarded to anyone else.) Both systems emit an `update` event on the collection, specifying the `tag` and the new `signature` object as properties of the event. An update is also emmitted for anything added during synchronization. It is possible to receive multiple update events on the same tag.

A `retrieve()` will produce the current signature per the collections synchronization algorithm (even if the systems have not yet finished synhcronization).

The synchronization algorithm can be specified individually for each Collection by specifying _`synchronize: function-TBD`_ to the constructor or to the synchronize method. This is how the defaults work:

### ImmutableCollection

The tag for these are automatically produced as the hash of their contents. (`anImmutableCollection.store(tag, data)` ignores the tag and can be ommitted.) So if you change anything at all, it's a different object with a different tag. If store() is called on something that already exists, it will not be overridden, and the original author's signature is preserved. I.e., the first author "wins", and that is the signature and timestamp that is preserved. 

The hashing is done _after_ any encryption, so the same payload encrypted for different teams creates different tags. However, a later `remove()` _does_ get respected (as long as the new signature is from the correct `owner`).

When synchronizing, the two storage services exchange a list of the [tag, timestamp] pairs that they have in their copy of the collection. Each side then retrieves each of the tags that it does not have at all, or which is _not newer_ than the one they have. In the second case, we have the same payload data, but we get the other side's signature anyway so that the author and timestamp are the same on both systems. This can occur when two unconnected devices both save the same exact data locally. 

In the extemely unlikely event of having duplicate [tag, timestamp], an arbitrary but deterministic result is chosen for both systems. Note that if two people tried to save different answers on a centralized server, a non-deterministic result would be chosen.


### MutableCollection

The identify of a mutable object does not change when the data changes over time. (It is like a place that is the same regardless of what is put there, or a ship that is still considered the same ship as each piece is replaced over time.) Here the second author "wins" (assuming they have permission, by being a now a member of the current owner team from the previous version).

When synchronizing, the two services exchange a list of their [tag, timestamp] pairs as for an ImmutableCollection, but here the later timestamp wins.

### VersionedCollection

This is a distinct kind of MutableCollection in which all versions are available. `retrieve()` accepts an additional timestamp argument, and will produce the result that was active at that timestamp (if any). If no timestamp is asked for, it answers the latest value, as for MutableCollection. Additionally, `aVersionedCollection.retrieveTimestamps(tag)` promises a list of all the timestamps.

A common use of `VersionedCollection` is to keep track of each item in a series of messages, transactions, etc. Think of each timestamp pointing to a separate ImmutableCollection tag that has the latest change. Work can be done offline or on a separated LAN, and then merged later to interleave the messages.

When synchronizing, each side sends over a list of [tag, listOfPayloadHashes]. Any missing items are retrieved and added to the object. (Note that `aVersionedCollection.retrieve(tag, optionalTimestamp)` produces a single signature with a particular timestamp -- there is no collected-works signature that we need to worry about forging. In the extremely unlikely event of a duplicate timestamp with different hashes, the deterministic preference algorithm is used to define the order in which _both_ items are included, generating a floating point timestamp in between the existing others.
