# API

## Exchange Format

Items are created in the client by optionally encrypting as [JWE](https://www.rfc-editor.org/rfc/rfc7516), and then signing the result as [JWS](https://datatracker.ietf.org/doc/html/rfc7515). These format includes an identification of the algorithm -- unless specified otherwise, our implementation uses the ES384 algorithm for signing, and RSA-OAEP-256 with a 4096 modulus length for encryption. The JWS is what is exchanged among services, and it the result is verified and decrypted at the client.

The synchronization process exchanges the following messages: _TBD_

## Accepting Changes to an Item

Regardless of whether a JWS comes from the client or another service, an implementation should do the following before persisting the JWS:

_TBD ... clean up deep verification explanation from [distributed-security](https://github.com/kilroy-code/distributed-security/blob/main/docs/advanced.md#signatures-with-multiple-tags-and-other-signature-options)..._

## Key Management

Private keys are themselves encrypted, signed, and stored within the `Team` collection of the system itself, using the same exchange and acceptance criteria as above. For each `author` or `owner` tag, the private decryption and signing keys are represented in a JWK that is encrypted so that it can only be decrypted by an enumerated list of recipients. These recipents are themselves tags representing other keypairs stored in one of three ways:

1. Yet another `author` or `owner` tag item in the `Team` collection. In this way, arbitrary hierarchies of teams are supported.
2. The tag for a local keypair that is encrypted and only stored locally on the user's device. (In browsers, we use indexedDB in a separate worker context that is not accessible from the application.) An application creates one of these for each browser in which the user runs the application, using either `Credentials.createAuthor()` or `Credentials.authorizeAuthor()`.
3. The tag for a recovery keypair, encrypted using a secret supplied by the user, and stored in the `KeyRecovery` collection. This is only to be used when adding the author to a new machine that does not yet have a local tag (2). For example, an application might ask the user for the answer to a combination of security questions (mother's maiden name, etc.) and canonicalize the answers to form a user-specific memorable text. 

For (2) and (3), the application is responsible for getting a secret from the user, using `Credentials.getUserDeviceSecret()`. _TBD better name_ (We then use this to encrypt the JWK using PBES2-HS512+A256KW.) Each application should produce it's own application-specific and user-specific results, but may safely share `author` and `team` tags (1) between applications if desired. In this way, an application may support multiple "login" users on the same browser. (See the [Distributed Security documention](https://github.com/kilroy-code/distributed-security/blob/main/README.md#initialization) for more information.)

In addition, the tags are url-safe base64 encodings of the public verification key that matches the private signing key described above. Thus any application can verify signatures using only the JWS signature itself (which always specifies the tag). The public encryption key is stored unencrypted as as signed JWS as the tag item in the `EncryptionKey` collection, so that anyone can encrypt for only the specified `author` or `owner` to read.

## Service Names

_TBD, but one of two things:_

1. _A hosted relay, specified via a URL for the specific collection. Must provide:_
   - _GET method for an endpoint formed by the url/:tag.jws._
   - _Either _
     - _PUT, DELETE and TBD methods_
     - _A two-way connection TBD, over which sync and update messages are exchanged._
2. _A GUID denoting a WebRTC peer data channel, over which sync, get, and update message are exchanged._

## Collection Names

_TBD Right now it is built in reverse-DNS. Applications might sync with specific collections on specific services, or based on the type of collection name, or using some directory, etc. An app that syncs to peer services will presumably sync the service names defined by the app itself._

_The details of collection names is TBD, but to avoid name conflicts and garbage in relays, it is likely one of the following types:_

1. _A name defined by this protocol: `Team`, `RecoveryTag`, `EncryptionKey`._
2. _Some sort of self-authorizing root. Maybe there's an "open collection" in which anyone can add name record. (Not clear how an "open collection" works or syncs. Might get censored by wherever it is stored.)_
3. _A site URL root. https:// would be prefixed (unless localhost) and something postfixed to produce a url that must store a name record. Doesn't require trusting a site holding (2), but requiring an operating https means that there is some sort of contact info and a means for law enforcement to shut it down._
4. _Some sort of parent:guid designation for a name record. E.g., the parent is any of these four, which owns a collection with a well-known name that has name records._

_Presumably, a name record is a JWS whose owner matches the authorizing parent (if any) and whose subject matches the child._

## Credentials

Credentials has all the same methods and properties as the default export of [@ki1r0y/distributed-security](https://github.com/kilroy-code/distributed-security), plus the following:

### Credentials Properties

**author** - Applications set this to a tag string, which then becomes the default for `author` parameter to `store()` and `retrieve()`.

**owner** - Applications set this to a tag string, which then becomes the default for `owner` parameter to `store()` and `retrieve()`.

**encryption** - Applications set this to a tag string, which then becomes the default for `author` parameter to `store()` and `retrieve()`

### Credentials Methods

**create()**

**destroy()**

**createAuthor()**

**authorizeAuthor()**

**getUserDeviceSecret()**

**synchronize()**


## Collections

ImmutableCollection

MutableCollection

VersionedCollection

### Collection Methods

constructor()

store()

retrieve() - _Also encrypts the data if needed, but only if any authorized `owner` in this browser is recursively a membership of the `owner` group specified by the operative `store()`. Option decrypt:false, too._

remove()

list() - order is not specifed

find() - will not work on encrypted data that the user is not authorized as per `retrieve()`.

addEventListener()

synchronize()
