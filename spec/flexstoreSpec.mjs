import { Persist, Credentials, MutableCollection } from '../loopback.mjs';
const { describe, beforeAll, afterAll, it, expect, expectAsync } = globalThis;

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
    await Credentials.destroy({tag: Credentials.author, recursiveMembers: true});
  });
  describe('smokes', function () {
    let user, someTag, data = {name: 'Alice', birthday: '01/01'};
    beforeAll(async function () {
      someTag = Credentials.author;
      user = await users.store(data, {tag: someTag});
    });
    afterAll(async function () {
      const fixme = await users.retrieve(someTag);
      await users.remove({tag: someTag});
      const signature = await users.retrieve(someTag);
      expect(signature.json).toBeUndefined();
    });
    it('stores.', function () {
      expect(user).toBe(someTag);
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
    describe('specifying owner', function () {
      let otherUser, team, previousOwner;
      const data = {name: 'Bob', birthday: '02/02'};
      beforeAll(async function () {
	otherUser = await Credentials.createAuthor('airspeed?');
	previousOwner = Credentials.owner;
	team = Credentials.owner = await Credentials.create(Credentials.author, otherUser);	
	expect(await users.store(data, {tag: otherUser})).toBe(otherUser);
      }, 10e3);
      afterAll(async function () {
	const maxList = await users.list();
	expect(maxList.length).toBe(2);
	await users.remove({tag: otherUser});
	const afterList = await users.list();
	expect((await users.retrieve(otherUser)).json).toBeUndefined();
	expect(afterList.length).toBe(1);
	await Credentials.destroy({tag: otherUser, recursiveMembers: true});
	await Credentials.destroy(team);
	Credentials.owner = previousOwner;
      });
      it('team members can re-store', async function () {
	data.birthday = '03/03';
	const originalAuthor = Credentials.author;
	Credentials.author = otherUser;
	expect(await users.store(data, {tag: otherUser}));
	Credentials.author = originalAuthor;
	const newSignature = await users.retrieve(otherUser);
	expect(newSignature.json).toEqual(data);
	expect(newSignature.protectedHeader.act).toBe(otherUser);
	expect(newSignature.protectedHeader.iss).toBe(team);	
      });
      it('cannot be written by non-team member.', async function () {
	let random = await Credentials.createAuthor("who knows?");
	await expectAsync(users.store({whatever: 'ignored'}, {tag: otherUser, author: random})).toBeRejected();
	await Credentials.destroy({tag: random, recursiveMembers: true});
      }, 10e3);
      it('adds to list.', async function () {
	const list = await users.list();
	const tags = [Credentials.author, otherUser];
	list.sort();
	tags.sort();
	expect(list).toEqual(tags);
      });
    });
  });
});
