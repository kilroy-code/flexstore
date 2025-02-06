import { Persist, Credentials, ImmutableCollection, MutableCollection, VersionedCollection } from '../loopback.mjs';
const { describe, beforeAll, afterAll, it, expect, expectAsync } = globalThis;

describe('Flexstore', function () {
  let user, otherUser, team;
  const services = ['/', 'https://ki1r0y.com/flex/'];
  beforeAll(async function () {
    Credentials.synchronize(services);
    // TODO:getUserDeviceSecret => prompt
    Credentials.getUserDeviceSecret  = function (tag, promptString) { // Used when first creating a user credential, or when adding an existing credential to a new device.
      function swizzle(seed) { return seed + 'appSalt'; } // Could also look up in an app-specific customer database.
      if (promptString) return swizzle(promptString); // fixme prompt(promptString)); 
      return swizzle(tag);
    };
    //window.Security = Credentials;

    // Make a user.
    user = Credentials.author = await Credentials.createAuthor('test pin:');
    otherUser = await Credentials.createAuthor('airspeed?');
    team = await Credentials.create(Credentials.author, otherUser);
  }, 15e3);
  afterAll(async function () {
    await Credentials.destroy({tag: otherUser, recursiveMembers: true});
    await Credentials.destroy(team);
    await Credentials.destroy({tag: user, recursiveMembers: true});
    //console.log(Persist.lists); // Did we clean up? Note that versions never go away.
  });
  function testCollection(collection, restoreCheck) {
    const label = collection.constructor.name;
    describe(label, function () {
      let tag, data = {name: 'Alice', birthday: '01/01'};
      let updateCount = 0, latestUpdate;
      beforeAll(async function () {
	collection.addEventListener('update', event => {
	  updateCount++;
	  latestUpdate = event.detail;
	});
	tag = await collection.store(data);
	expect(updateCount).toBe(1);
	expect(latestUpdate.tag).toBe(tag);
	expect(latestUpdate.json).toEqual(data);
      });
      afterAll(async function () {
	updateCount = 0;
	await collection.remove({tag});
	expect(updateCount).toBe(1);
	expect(latestUpdate.tag).toBe(tag);
	expect(latestUpdate.json).toBeFalsy();
	const signature = await collection.retrieve(tag);
	expect(signature.json).toBeUndefined();
      });
      //beforeEach(function () { collection.debug = false; });
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
	  updateCount = 0;
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
	  expect(updateCount).toBe(4); // 2 successfull stores and 2 removes.
	});
	it('team members can re-store', async function () {
	  const newData = Object.assign({}, data, {birthday: '03/03'});
	  Credentials.author = otherUser;
	  tag3 = await collection.store(newData, {tag: tag2});
	  Credentials.author = user;
	  const newSignature = await collection.retrieve(tag2);
	  expect(newSignature.protectedHeader.iss).toBe(team);	
	  await restoreCheck(data, newData, newSignature, tag2, tag3, collection);
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
		 async (firstData, newData, signature, firstTag, newTag, collection) => {
		   expect(firstTag).not.toBe(newTag);
		   expect(signature.json).toEqual(firstData);
		   expect(signature.protectedHeader.act).toBe(user);
		   // newData was not dropped altogether. It was saved in newTag
		   const anotherSig = await collection.retrieve(newTag);
		   expect(anotherSig.json).toEqual(newData);
		   expect(anotherSig.protectedHeader.act).toBe(otherUser);
		 });
  testCollection(new MutableCollection({name: 'com.acme.mutable', services}),
		 (firstData, newData, signature, firstTag, newTag) => {
		   expect(firstTag).toBe(newTag);
		   expect(signature.json).toEqual(newData);
		   expect(signature.protectedHeader.act).toBe(otherUser);
		 });
  testCollection(new VersionedCollection({name: 'com.acme.versioned', services}),
		 async (firstData, newData, signature, firstTag, newTag, collection) => {
		   expect(firstTag).toBe(newTag);
		   expect(signature.json).toEqual(newData);
		   expect(signature.protectedHeader.act).toBe(otherUser);

		   const timestamps = await collection.retrieveTimestamps(firstTag);
		   expect(timestamps.length).toBe(2); // 'latest' plus two times

		   // Can specify a specific time, and get the version that was in force then.
		   
		   // A specific matching time. In this case, the earliest time.
		   expect((await collection.retrieve({tag: firstTag, time: timestamps[0]}))?.json).toEqual(firstData);
		   // A time before the first, and get nothing.
		   expect((await collection.retrieve({tag: firstTag, time: timestamps[0] - 1}))?.json).toBeUndefined();
		   // A time in between entries, and get the largest one that is before what is specifed.
		   expect((await collection.retrieve({tag: firstTag, time: timestamps[0] + 1}))?.json).toEqual(firstData);		   
		   // A time after the last and get the same as the last.
		   expect((await collection.retrieve({tag: firstTag, time: timestamps[1] + 1}))?.json).toEqual(newData);
		 });
});
