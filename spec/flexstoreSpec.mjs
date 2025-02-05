import { Persist, Credentials, ImmutableCollection, MutableCollection, VersionedCollection } from '../loopback.mjs';
const { describe, beforeAll, afterAll, it, expect, expectAsync } = globalThis;

describe('Flexstore', function () {
  let user, otherUser, team;
  const services = ['/', 'https://ki1r0y.com/flex/'];
  beforeAll(async function () {
    Credentials.synchronize(services);
    Credentials.prompt = function (tag, promptString) { // Used when first creating a user credential, or when adding an existing credential to a new device.
      function swizzle(seed) { return seed + 'appSalt'; } // Could also look up in an app-specific customer database.
      if (prompt) return swizzle(promptString); // fixme prompt(promptString)); 
      return swizzle(tag);
    };

    // Make a user.
    user = Credentials.author = await Credentials.createAuthor('test pin:');
    otherUser = await Credentials.createAuthor('airspeed?');
    team = await Credentials.create(Credentials.author, otherUser);
  }, 15e3);
  afterAll(async function () {
    await Credentials.destroy({tag: otherUser, recursiveMembers: true});
    await Credentials.destroy(team);
    await Credentials.destroy({tag: user, recursiveMembers: true});
  });
  function testCollection(collection, restoreCheck) {
    const label = collection.constructor.name;
    describe(label, function () {
      let tag, data = {name: 'Alice', birthday: '01/01'};
      beforeAll(async function () {
	tag = await collection.store(data);
      });
      afterAll(async function () {
	await collection.remove({tag});
	const signature = await collection.retrieve(tag);
	expect(signature.json).toBeUndefined();
      });
      it('stores.', function () {
	expect(typeof tag).toBe('string');
      });
      it('retrieves.', async function () {
	const signature = await collection.retrieve(tag);
	expect(signature.json).toEqual(data);
      });
      it('lists.', async function () {
	expect(await collection.list()).toEqual([tag]);
      });
      it('finds', async function () {
	expect(await collection.find({name: 'Alice'})).toBe(tag);
      });
      describe('specifying owner', function () {
	let previousOwner, tag2, tag3;
	const data = {name: 'Bob', birthday: '02/02'};
	beforeAll(async function () {
	  previousOwner = Credentials.owner;
	  Credentials.owner = team;
	  tag2 = await collection.store(data);
	}, 10e3);
	afterAll(async function () {
	  await collection.remove({tag: tag2});
	  await collection.remove({tag: tag3});	 // May be a no-op.
	  const afterList = await collection.list();
	  expect((await collection.retrieve(tag2)).json).toBeUndefined();
	  expect((await collection.retrieve(tag3)).json).toBeUndefined();	  
	  expect(afterList.length).toBe(1);
	  Credentials.owner = previousOwner;
	});
	it('team members can re-store', async function () {
	  const newData = Object.assign({}, data, {birthday: '03/03'});
	  Credentials.author = otherUser;
	  tag3 = await collection.store(newData, {tag: tag2});
	  Credentials.author = user;
	  const newSignature = await collection.retrieve(tag2);
	  expect(newSignature.protectedHeader.iss).toBe(team);	
	  await restoreCheck(data, newData, newSignature, tag2, tag3);
	});
	it('cannot be written by non-team member.', async function () {
	  let random = await Credentials.createAuthor("who knows?");
	  await expectAsync(collection.store({whatever: 'ignored'}, {tag: tag2, author: random})).toBeRejected();
	  await Credentials.destroy({tag: random, recursiveMembers: true});
	}, 10e3);
	it('adds to list.', async function () {
	  const list = await collection.list();
	  expect(list).toContain(tag);
	  expect(list).toContain(tag2);
	});
      });
    });
  }
  testCollection(new ImmutableCollection({name: 'com.acme.immutable', services}),
		 (firstData, newData, signature, firstTag, newTag) => {
		   expect(firstTag).not.toBe(newTag);
		   expect(signature.json).toEqual(firstData);
		   expect(signature.protectedHeader.act).toBe(user);		   
		 });
  testCollection(new MutableCollection({name: 'com.acme.mutable', services}),
		 (firstData, newData, signature, firstTag, newTag) => {
		   expect(firstTag).toBe(newTag);
		   expect(signature.json).toEqual(newData);
		   expect(signature.protectedHeader.act).toBe(otherUser);
		 });
  testCollection(new VersionedCollection({name: 'com.acme.versioned', services}),
		 (firstData, newData, signature, firstTag, newTag) => {
		   expect(firstTag).toBe(newTag);
		   expect(signature.json).toEqual(newData);
		   expect(signature.protectedHeader.act).toBe(otherUser);		   
		 });
});
