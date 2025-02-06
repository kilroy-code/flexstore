# @ki1r0y/flexstore

Flexstore lets you easily and safely set up a key-value JSON store in a browser or NodeJS app, which _also_ lets you work offline, federate the storage across relay servers, and even p2p between browser clients. All changes are automatically shared in realtime, and an 'update' event can be listened for.

It is a very simple (and efficient and secure!) way to have shared, authenticated, live data in an app that works online or offline.

- Everything is signed so that wherever the data is stored, you can be sure who saved it and that it has not since been modified.
- Everything is optionally encrypted, so that it can only be read by the intended audience.
- The keys are safely stored in the system itself (signed and encrypted) so that they are available from the cloud to your users' devices. The keys are user-managed, and there are no custodial copies -- i.e., even you do not have access.

## Why

I built this because I had finally gone through the following scenario too many times. YMMV, and you can skip this section.

1. Cool, a new project. I'll just use fetch on the client and whip up some ExpressJS middleware for the server. And a database.
2. Oh, but authentication. Now IT is involved.
3. Hmm, we need to know when another user changed something. I'll add websockets.
4. Wait, you want this to work offline, too? Um, ok... (How DO we reconcile...?)
5. And realtime p2p?!?! Yeah, we can build that....
6. What exactly do you mean by "auditable"?
7. Well, yes, the IT admin COULD read the user's data. Yes, I could encrypt that...
8. No, I don't have a plan for what happens if the user loses their encryption keys.


## Example

The interface is simple:
```
import { Credentials, MutableCollection } from '@ki1r0y/flexstore';

// An app can have several Collections, with different sets of online services.
const services = ['/', 'https://ki1r0y.com/flex/'];
// Start synchronizing the users collection with each of the listed services that are reachable.
// Other Collection subclasses are ImmutableCollection and VersionedCollection.
const users = new MutableCollection({name: 'users.acme.com, services});
// There are some in
ternal collections for credentials. Synchronize those, too.
Credentials.synchronize(services);


async function someApp(someTag, currentUserTag) {
  Credentials.author = currentUserTag; // Must be set before using store() and remove(). 
  users.addEventListener('update', (tag, signature) => console.log(`${signature.act} updated ${tag}!`));

  await users.store(someTag, {name: 'Alice', birthday: '01/01'});
  const userSignature = await users.retrieve(someTag); // Gets the synchronized signed data.
  const userData = userSignature.json // {name: 'Alice', ...} Depending on what was stored, .text and .payload are also available.
  const allUsers = await users.list();
  await users.remove(someTag); // Locally and on all services. After this, retrieve() will produce the signature of the 
  // the author that removed it, and the payload/text/json will be falsy.

  // Synchronize an additional service, which in this case is another client peer:
  const peerSession = "some agreed upon name that does not start with http, /, or ./";
  await users.synchronize(peerSession);
  users.disconnect(peerSession);  // If we don't want to stay connected to them, regardless of whether started automatically or manually.
}


// Annoying preliminaries for credentials before we call someApp. Still, it's a lot less than other approaches.
//
// In a browser. These few lines both cover and ignore a lot of complexity.
let currentAuthorTag = localStorage.getItem('existingTag'); // From last time, if any.
Credentials.getUserDeviceSecret = function (tag, promptString) { // Used when first creating a user credential, or when adding an existing credential to a new device.
  function swizzle(seed) { return seed + 'appSalt'; } // Could also look up in an app-specific customer database.
  if (prompt) return swizzle(prompt(promptString)); 
  return swizzle(tag);
};
// We need a valid credential to sign "write" requests.
// If there isn't a currentAuthorTag from last time, either authorize one (for this new machine) or create a new one.
if (!currentAuthorTag) {
  const username = prompt("Your existing username? Blank for none.");
  const currentAuthorTag = username && await users.find({name: username});
  // If username provided and it exists, try to authorize it on this machine, which will call Credentials.prompt and check the answer.
  if (currentAuthorTag) {
    await Credentials.authorizeAuthor(currentAuthorTag).catch(_ => currentAuthorTag = null);
  }
  if (!currentAuthorTag) { // Wasn't entered, found, or matched. Create one, which will prompt and save the response.
     currentAuthorTag = await Credentials.createAuthor({prompt: "Enter a pin:"});
  });
}
localStorage.setItem('existingTag', currentAuthorTag); // Save for next time.

someApp(currentAuthorTag, currentAuthorTag);
```

In the example above, only the `Credentials.author` has beeen set, and not a `Credentials.owner`. In this case, only the author will be able to `store()` new data or `remove()` it (for any mutable collection). 

We can arrange for any one of an enumerated group of users to be able to make changes, by specifying `Credentials.owner`.
```
const teamAlice = Credentials.create(Credentials.author, someOtherUserTag, andYetAnotherUserTag);
Credentials.owner = teamAlice;
// Now everything stored will be readable only by author, someOtherUserTag, andYetAnotherUserTag.

// One might want to record the team we made:
userData.team = teamAlice;
await users.store(someTag,  userData);
```

By the way, a user can be on any number of owner teams, and teams can have other teams as members. In a distributed system (and arguably in all systems), this way of specifying ownership is more flexible than trying to maintain a set of "write permissions" via an access control list. The owner can be specified individually on each `store()` -- specifying a current `Credentials.owner` is just a convenience. 


We can also arrange for only the members of a team to be able to _read_ the data. This is done by encrypting the data on the client before it is signed, and decrypting it on the client after it is verfied. This can be done manually, automatically by `store()`, or by specifying a current `Credentials.encryption = true` (encrypt for owner team if specified, otherwise only the author), or `Credentials.encryption = somOtherTeamTag`.

## Pseudonymity

`author` and `owner` tags are stable strings that may or may not correspond to distinct individuals or groups. This protocol does not provide any central collection of users, but applications may do so for their users, and such applications might or might not include attestations as to human identities signed by some authority. An individual human or group of people may create different tags for different applications, multiple tags within an application, or may re-use a tag at their (and the application's) discretion.

An application can allow (or require) a user to encrypt data within a collection (e.g., all items, particular property values, etc.). Additionaly, an application may synchronize only with its own service, or may choose to relay data with other services, and this includes the [`Team`](#key-management) collection. However, the membership tags of an `owner` group are readable by anyone who has access to the collection. 

(TBD: As it stands now, this is how the underlying private key access works. (Reliable and well-tested.) When a user needs the private signing or decrypting key for a given tag, distributed-security gets the list of member tags, and will use the first successful member key to unlock, recursively following membership to a local or recovery key (2) or (3) in key management, below. So they have to be public. It might be possible to maintain some sort of personal collection of team tags to use instead, so that the member tags can instead be listed as one-way hashes to prove membership IFF you know what key you are testing.)


## Synchronization

All collections start synchronizing their listed services at construction, and will stay connected until `disconnect()`. (Of source, the services list can be empty.) Services can later be added explicitly with the `synchronize()` method.

While we are connected, any `store()` or `remove()` calls on either system are forwarded to the other. (These internally forwarded calls are not transitively forwarded to anyone else.) Both systems emit an `update` event on the collection, specifying the `tag` and the new `signature` object as properties of the event. An update is also emmitted for anything added during synchronization. It is possible to receive multiple update events on the same tag, in an order that is different than what would be produced by synchronization. In this case, an additional update event is emitted with the "better" signature.

A `retrieve()` will produce the current signature per the collections synchronization algorithm (even if the systems have not yet finished synhcronization).

The synchronization algorithm can be specified individually for each Collection by specifying `synchronize: function-TBD` to the constructor or to the synchronize method. This is how the defaults work:

### ImmutableCollection

The tag for these are automatically produced as the hash of their contents. (`anImmutableCollection.store(tag, data)` ignores the tag and can be ommitted) So if you change anything at all, it's a different object with a different tag. If store() is called on something that already exists, it will not be overridden, and the original author's signature is preserved. I.e., the first author "wins", and that is the signature and timestamp that is preserved. The hashing is done _after_ any encryption, so the same payload encrypted for different teams creates different tags. However, a later `remove()` _does_ get respected (as long as the new signature is from the correct `owner`).

When synchronizing, the two storage services exchange a list of the [tag, timestamp] pairs that they have in their copy of the collection. Each side then retrieves each of the tags that it does not have at all, or which is _not newer_ than the one they have. In the second case, we have the same payload data, but we get the other side's signature anyway so that the author and timestamp are the same on both systems. This can occur when two unconnected devices both save the same exact data locally. 

In the extemely unlikely event of having duplicate [tag, timestamp], an arbitrary but deterministic result is chosen for both systems. Note that if two people tried to save different answers on a centralized server, a non-deterministic result would be chosen.


### MutableCollection

The identify of a mutable object does not change when the data changes over time. (It is like a place that is the same regardless of what is put there, or a ship that is still considered the same as each piece is replaced over time.) Here the second author "wins" (assuming they have permission, by being a now a member of the current owner team from the previous version).

When synchronizing, the two services exchange a list of their [tag, timestamp] pairs as for an ImmutableCollection, but here the later timestamp wins.

### VersionedCollection

This is a distinct kind of MutableCollection in which all versions are available. `retrieve()` accepts an additional timestamp argument, and will produce the result that was active at that timestamp. Otherwise, it answers the latest value, as for MutableCollection. Additionally, `aVersionedCollection.retrieveTimestamps(tag)` promises a list of all the timestamps.

A common use of `VersionedCollection` is to keep track of each item in a series of messages, transactions, etc. Think of each timestamp pointing to a separate ImmutableCollection tag that has the latest change. Work can be done offline or on a separated LAN, and then merged later to interleave the messages.

When synchronizing, each side sends over a list of [tag, listOfPayloadHashes]. Any missing items are retrieved and added to the object. (Note that `aVersionedCollection.retrieve(tag, optionalTimestamp)` produces a single signature with a particular timestamp -- there is no collected-works signature that we need to worry about forging. In the extremely unlikely event of a duplicate timestamp with different hashes, the deterministic preference algorithm is used to define the order in which _both_ items are included, using a floating point timestamp.

## API

### Exchange Format

Items are created in the client by optionally encrypting as [JWE](https://www.rfc-editor.org/rfc/rfc7516), and then signing the result as [JWS](https://datatracker.ietf.org/doc/html/rfc7515). This format includes an identification of the algorithm -- unless specified otherwise, our implementation uses the ES384 algorithm for signing, and RSA-OAEP-256 with a 4096 modulus length for encryption. The JWS is what is exchanged among services, and it the result is verified and decrypted at the client.

The synchronization process exchanges the following messages: TBD

### Accepting Changes to an Item

Regardless of whether a JWS comes from the client or another service, an implementation should do the following before persisting the JWS:

... clean up deep verification explanation from [distributed-security](https://github.com/kilroy-code/distributed-security/blob/main/docs/advanced.md#signatures-with-multiple-tags-and-other-signature-options)...

### Key Management

Private keys are themselves encrypted, signed, and stored within the `Team` collection of the system itself, using the same exchange and acceptance criteria as above. For each `author` or `owner` tag, the private decryption and signing keys are represented in a JWK that is encrypted so that it can only be decrypted by an enumerated list of recipients. These recipents are themselves tags representing other keypairs stored in one of three ways:

1. Yet another `author` or `owner` tag item in the `Team` collection. In this way, arbitrary hierarchies of teams are supported.
2. The tag for a local keypair that is encrypted and only stored locally on the user's device. (In browsers, we use indexedDB in a separate worker context that is not accessible from the application.) An application creates one of these for each browser in which the user runs the application, using either `Credentials.createAuthor()` or `Credentials.authorizeAuthor()`.
3. The tag for a recovery keypair, encrypted using a secret supplied by the user, and stored in the `KeyRecovery` collection. This is only to be used when adding the author to a new machine that does not yet have a local tag (2). For example, an application might ask the user for the answer to a combination of security questions (mother's maiden name, etc.) and canonicalize the answers to form a user-specific memorable text. 

For (2) and (3), the application is responsible for getting a secret from the user, using `Credentials.getUserDeviceSecret()`. _TBD better name_ (We then use this to encrypt the JWK using PBES2-HS512+A256KW.) Each application should produce it's own application-specific and user-specific results, but may safely share `author` and `team` tags (1) between applications if desired. In this way, an application may support multiple "login" users on the same browser. 

In addition, the tags are url-safe base64 encodings of the public verification key that matches the private signing key described above. Thus any application can verify signatures using only the JWS signature itself (which always specifies the tag). The public encryption key is stored unencrypted as as signed JWS as the tag item in the `EncryptionKey` collection, so that anyone can encrypt for only the specified `author` or `owner` to read.

### Service Names

TBD, but one of two things:

1. A hosted relay, specified via a URL for the specific collection. Must provide:
   - GET method for an endpoint formed by the url/:tag.jws.
   - Either 
     - PUT, DELETE and TBD methods
     - A two-way connection TBD, over which sync and update messages are exchanged.
2. A GUID denoting a WebRTC peer data channel, over which sync, get, and update message are exchanged.

### Collection Names

Right now it either built in reverse-DNS. Applications might sync with specific collections on specific services, or based on the type of collection name, or using some directory, etc. An app that syncs to peer services will presumably sync the service names defined by the app itself.

The details of collection names is TBD, but to avoid name conflicts and garbage in relays, it is likely one of the following types:

1. A name defined by this protocol: `Team`, `RecoveryTag`, `EncryptionKey`.
2. Some sort of self-authorizing root. Maybe there's an "open collection" in which anyone can add name record. (Not clear how an "open collection" works or syncs. Might get censored by wherever it is stored.)
3. A site URL root. https:// would be prefixed (unless localhost) and something postfixed to produce a url that must store a name record. Doesn't require trusting a site holding (2), but requiring an operating https means that there is some sort of contact info and a means for law enforcement to shut it down.
4. Some sort of parent:guid designation for a name record. E.g., the parent is any of these four, which owns a collection with a well-known name that has name records.

Presumably, a name record is a JWS whose owner matches the parent and whose subject matches the child.

### Credentials

Credentials has all the same methods and properties as the default export of [@ki1r0y/distributed-security](https://github.com/kilroy-code/distributed-security), plus the following:

#### Credentials Properties

**author** - Applications set this to a tag string, which then becomes the default for `author` parameter to `store()` and `retrieve()`.

**owner** - Applications set this to a tag string, which then becomes the default for `owner` parameter to `store()` and `retrieve()`.

**encryption** - Applications set this to a tag string, which then becomes the default for `author` parameter to `store()` and `retrieve()`

#### Credentials Methods

**create()**

**destroy()**

**createAuthor()**

**authorizeAuthor()**

**getUserDeviceSecret()**

**synchronize()**


### Collections

ImmutableCollection

MutableCollection

VersionedCollection

#### Collection Methods

constructor()

store()

retrieve() - Decrypts the data, but only if any authorized `owner` in this browser is recursively a membership of the `owner` group specified by the operative `store()`.

remove()

list() - order is not specifed

find() - will not work on encrypted data that the user is not authorized as per `retrieve()`.

addEventListener()

synchronize()
