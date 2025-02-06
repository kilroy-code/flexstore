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
const users = new MutableCollection({name: 'com.acme.users', services});
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

### Credentials

Credentials has all the same methods and properties as the default export of [@ki1r0y/distributed-security](https://github.com/kilroy-code/distributed-security), plus the following:

Credentials.createAuthor()
Credentials.authorizeAuthor()
Credentials.synchronize()
Credentials.author
Credentials.owner
Credentials.encryption

### Collections

ImmutableCollection
MutableCollection
VersionedCollection

aCollection.store()
aCollection.retrieve()
aCollection.remove()
aCollection.list() - order is not specifed
aCollection.find()
