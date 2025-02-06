import { Persist, Credentials, ImmutableCollection, MutableCollection, VersionedCollection } from '../loopback.mjs';
const { describe, beforeAll, afterAll, it, expect, expectAsync } = globalThis;

describe('Flexstore', function () {
  let user, otherUser, team, randomUser;
  const services = ['/', 'https://ki1r0y.com/flex/'];
  const blocks = Array.from({length: 1000}, (_, index) => ({index}));
  beforeAll(async function () {
    Credentials.synchronize(services);
    // TODO:getUserDeviceSecret => prompt
    Credentials.getUserDeviceSecret  = function (tag, promptString) { // Used when first creating a user credential, or when adding an existing credential to a new device.
      function swizzle(seed) { return seed + 'appSalt'; } // Could also look up in an app-specific customer database.
      if (promptString) return swizzle(promptString); // fixme prompt(promptString)); 
      return swizzle(tag);
    };
    //window.Security = Credentials;

    // user, otherUser, and randomUser are distinct users authorized on this machine. Only user and otherUser are on team.
    user = Credentials.author = await Credentials.createAuthor('test pin:');
    otherUser = await Credentials.createAuthor('airspeed velocity?');
    team = await Credentials.create(Credentials.author, otherUser);
    randomUser = await Credentials.createAuthor("favorite color?");
    
  }, 25e3);
  afterAll(async function () {
    await Credentials.destroy({tag: randomUser, recursiveMembers: true});
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
      it('cannot be written by a different user (even with the same data).', async function () {
	collection.debug = true;
	await expectAsync(collection.store(data, {tag, author: randomUser})).toBeRejected();
	collection.debug = false;
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
	  Credentials.encryption = 'team';
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
	  expect(newSignature.decrypted.protectedHeader.kid).toBe(team); // encrypted for the whole team.
	  await restoreCheck(data, newData, newSignature, tag2, tag3, collection);
	});
	it('cannot be written by non-team member.', async function () {
	  await expectAsync(collection.store({whatever: 'ignored'}, {tag: tag2, author: randomUser})).toBeRejected();
	});
	it('adds to list.', async function () {
	  const list = await collection.list();
	  expect(list).toContain(tag);
	  expect(list).toContain(tag2);
	});
      });
      describe('performance', function () {
	describe('serial', function () {
	  let tags = Array(blocks.length), writesPerSecond;
	  beforeAll(async function () {
	    //console.log(label, 'author/owner', Credentials.author, Credentials.owner);
	    const start = Date.now();
	    let i = 0;
	    for (const datum of blocks)  {
	      tags[i++] = await collection.store(datum);
	    }
	    const elapsed = Date.now() - start;
	    writesPerSecond = blocks.length / (elapsed / 1e3);
	    console.log(label, 'serial writes/second', writesPerSecond);
	  });
	  afterAll(async function () {
	    await Promise.all(tags.map(tag => collection.remove({tag})));
	  });
	  it('writes.', function () {
	    expect(writesPerSecond).toBeGreaterThan(200);
	  });
	  it('reads.', async function () {
	    const start = Date.now();
	    for (const tag of tags)  {
	      await collection.retrieve(tag);
	    }
	    const elapsed = Date.now() - start;
	    const readsPerSecond = blocks.length / (elapsed / 1e3);
	    console.log(label, 'serial reads/second', readsPerSecond);
	    expect(readsPerSecond).toBeGreaterThan(500);
	  });
	});
	describe('parallel', function () {
	  let tags = Array(blocks.length), writesPerSecond;
	  beforeAll(async function () {
	    //console.log(label, 'author/owner', Credentials.author, Credentials.owner);
	    const start = Date.now();
	    tags = await Promise.all(blocks.map(datum => collection.store(datum)));
	    const elapsed = Date.now() - start;
	    writesPerSecond = blocks.length / (elapsed / 1e3);
	    console.log(label, 'parallel writes/second', writesPerSecond);
	  });
	  afterAll(async function () {
	    await Promise.all(tags.map(tag => collection.remove({tag})));
	  });
	  it('writes.', function () {
	    expect(writesPerSecond).toBeGreaterThan(400);
	  });
	  it('reads.', async function () {
	    const start = Date.now();
	    await Promise.all(tags.map(tag => collection.retrieve(tag)));
	    const elapsed = Date.now() - start;
	    const readsPerSecond = blocks.length / (elapsed / 1e3);
	    console.log(label, 'parallel reads/second', readsPerSecond);
	    expect(readsPerSecond).toBeGreaterThan(1500);
	  });
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
