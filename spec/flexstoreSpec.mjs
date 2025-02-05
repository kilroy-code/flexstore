import { Persist, Credentials, MutableCollection } from '../loopback.mjs';
const { describe, beforeAll, afterAll, it, expect } = globalThis;

describe('Flexstore', function () {
  let users;
  beforeAll(async function () {
    const services = ['/', 'https://ki1r0y.com/flex/'];
    // Start synchronizing the users collection with each of the listed services that are reachable.
    // Other Collection subclasses are ImmutableCollection and VersionedCollection.
    users = new MutableCollection({name: 'com.acme.users', services});
    // There are some internal collections for credentials. Synchronize those, too.
    Credentials.synchronize(services);

    Credentials.prompt = function (tag, promptString) { // Used when first creating a user credential, or when adding an existing credential to a new device.
      function swizzle(seed) { return seed + 'appSalt'; } // Could also look up in an app-specific customer database.
      if (prompt) return swizzle(promptString); // fixme prompt(promptString)); 
      return swizzle(tag);
    };

    // Make a user.
    Credentials.author = await Credentials.createAuthor('test pin:');
  }, 10e3);
  afterAll(async function () {
    //await Credentials.destroy({tag: userTag, recursiveMembers: true});
  });
  describe('smokes', function () {
    let user, someTag, data = {name: 'Alice', birthday: '01/01'};
    beforeAll(async function () {
      someTag = Credentials.author;
      user = await users.store(data, {tag: someTag});
    });
    it('stores.', function () {
      expect(user).toBeTruthy();
    });
    it('retrieves.', async function () {
      const signature = await users.retrieve(someTag);
      expect(signature.json).toEqual(data);
    });
    it('lists.', async function () {
      expect(await users.list()).toEqual([someTag]);
    });
    it('finds', async function () {
      expect(await users.find({name: 'Alice'})).toBe(someTag);
    });
  });
});
