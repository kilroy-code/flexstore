# Limitations, Risks, and Mitigations

## Exposing Content

Most applications are expected to use the built in encryption so that it can only be read by the intented group. (Together with cryptographic signatures, this allows content to be [relayed](../README.md#flexstore) through untrusted devices.) Of course, once displayed, the intended group members can screenshot the content and share it.

The current software does _not_ currently watermark encrypted content.

## Public Identification

An application may choose to offer a public registry of users or groups. Presumably, this would be opt-in, and that the public user or group name might be different than that used within some private group. 

Regardless, an app may allow a group member to send an invitation to join a group over the Internet, identifying it by pseudonymous tag. Anyone who posses this invitation would then know of the existence of the tag, and could re-share it. It is also possible to share such invitations face-to-face (e.g., by QR code).


## Side-Channel Analysis

While the content itself is secure, the existence of activity is open to anyone who has the data:
- Activity is signed, indicating the pseudonymous tag of the user that took the action, and the time they did so.
- Each group of keys enumerates the psuudonymous tags that are the constituent members of that group.

An app may choose to allow humans to create multiple identities for different groups, or even multiple identities within a group. It is possible to securely demonstrate online that to a human that you are are the person identified by two or more such identities. However, this leaves a public trail of activity that can analyzed.

This software allows the encrypted content and its analyzable metadata to be shared in three ways:
1. Through public relay servers, where the metadata and the fact of the tags' existence is open to anyeone.
2. Directly from peer to peer, over the Internet. If activity is only shared in this way or the next, the signature and analyzable metadata is simply not available to others. Realtime synchronous communication requires both peers to be online at the same time, but activity can be recorded separately and then relayed to each other over a brief connection. However, the peers must be introduced to each other through a server, and so the time and IP addresses of the connection is knowable, but nothing about the exchange itself. 
3. Directly from peer to peer on a local network (e.g., a local wifi or hotspot). Here even the time and IP address of the exchange is known only on the local network.

## Shutdown

This free and open source software is designed to be used from secure Web page, including installed [PWAs](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps). While a PWA can be distributed through app stores, it can also be installed through any HTTPS site or mirror that carries it. While it is not terribly difficult to run an HTTPS site, it is not trivial either. Apps may choose to provide a public collection of current mirrors.

An app that uses this API can share data with other apps that use this API, even if the app code is different or hosted from different mirrors.

See also [Losing Content](#losing-content).

## Device Access

If someone can operate a device with a Flexstore application installed, they can use it [as if they were the rightful user](https://en.wikipedia.org/wiki/Evil_maid_attack).

The cryptographic keys used for signing and decryption are secured by unique keys stored only on the user's device. Our software has provisions for an app to include the following, but it is up to the app to do so:
- A pin, passphrase, or other secret that must be entered to locally unlock the local keys (in addition to the access controls provided by the device itself).
- A panic button that deletes the local keys or the whole app and its storage. (See [Losing Keys](#loosing-keys), below.) The current software does _not_ use a delete that overwrites the keys with junk data.

Note that browsers have debugging tools require either physical access or certain permissioned access. See [Stealing Keys](#stealing-keys) and [Malicious Software](#malicious-software).


## Losing Content

All content, including the users' cryptographic keys, are available from wherever they have been relayed. This may be a public relay or individual peers. If a device is lost or wiped, a user's access can be restored merely by opening the app (see [Shutdown](#shutdown), and [recovering their keys](#losing-keys).

## Losing Keys

If someone loses access to their device or wipes the app and local storage, they can recover their identity from another device. A virtual device key is encrypted by the application and stored among the other keys in [relayable data](#losing-content). The application controls how the encrypting secret is obtained from the user, but best practice is to have a number of such "recovery keys" that are based on different combinations of multiple canonicalized security questions. (Mother's maiden name and the like.)

These recovery keys are then used by the application to add a new local device key for the current device, and adding it to the relable key tag for the user.

## Stealing Keys

In a browser, the software that uses the keys is kept in a separate browsing context with its own local storage that is separate from the application. The unencrypted keys themselves are thus not available to the application code:
- They might be copyable through browser [debugging tools](#device-access) or browser bugs.
- [Malicious Software](#malicious-software) could use the API to ask the keys to sign or decrypt data, without actually obtaining the keys themselves.

The NodeJS server implementation of this software does not use a separate browsing context.

## Malicious Software

Just as physical access to a device may allow a human to operate the app as if they were the authorized user, malicious software may be introduced into an application to ["operate" it programmatically](https://en.wikipedia.org/wiki/Confused_deputy_problem). There are several ways this can happen:
- Most browsers allow third-party "extensions" to be installed into the browser. These can read every page visited, including PWAs, and inject software into the app unseen. Do not use browser extensions!
- A user can sometimes be tricked into running malicious code directly, using the browser's debugging tools. Do not paste code into the browser "console".
- Modern browser applications often include other software written by third-parties, to do specific tasks. These, in turn, often include other third-party software, and so forth. It is not uncommon for applications to be written without a full understanding of what each of these "dependencies" actually do.
- A stand-alone application (not a browser software) can be written to use this [API](./api.md), and a user can be convinced to run it. Note: while a public relay does need _a_ key to sign certain merges, it does _not_ need access to any particular groups or secrets. Do not trust code that claims otherwise.


## Claims of Priority

When the software accepts data from a Flexstore app or relayed from another device, it will reject ImmutableCollection items that have different content (i.e, which hashes to something other than the tag under which it stored) or a different owner. In other words, immutable content cannot be changed.

However, the signature being stored can be a different author and timestamp than what the system already has stored. The one with earlier timestamp is the one that will be used. This might conceivably be misinterpreted as showing who was the first to create the item, and what time they did so. This interpretation is wrong in several ways.

First, the content could have been created by anyone, and merely copied into the system by the claimant. The mitigation is that the person introducing the data is are irrupudiably signing that they have the right to use the content.

Second, on a centralized server, there is no way to know or control whose packet will arrive first when two people make an entry at the "same" time. This window is arbitrarilly longer when relays are involved, as there can be considerable clock differences between people who are creating records while offline and merging them later on.

Finally, someone could try to make a claim of priority by setting their device clock backward and creating an entry. 

1. If this possibility creates an issue for an application, it should create records that include a signed entry from a trusted [timeserver](https://en.wikipedia.org/wiki/ANSI_ASC_X9.95_Standard). Alas, such timestamping requires that the client be online, and some uses of our software might involve offline use.
2. Even offline use can create linked entries, such that separate items are definitely signed before the next item that links back to it. Two independent, offline branches can both be cited by a merging link, such that both antecedent branches definitely occured before the merged branch that cites them.
3. The app can also use a VersionedCollection instead of an ImmutableCollection, in which ALL the claims are retained rather than just the first. This does three things:
   a. It retains all the immutable versions, rather than just the earliest or the latest. Then each version can be examined and the "true" originator may be adjudicated by humans.
   b. The VersionedCollection protocol is designed in such a way that merging verifies the linked history of each branch (technique 2), and keeps these results for later examination.
   c. In future versions, IFF the merge happens to be done online, a trusted timeserver signature will be added to the merge result, providing a reliable upper bound on when the previous items occured.

