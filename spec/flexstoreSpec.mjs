import { Credentials, ImmutableCollection, StateCollection, MutableCollection, VersionedCollection } from '@kilroy-code/flexstore';
const { describe, beforeAll, afterAll, it, expect, expectAsync, URL } = globalThis;

// N.B.: If a previous failed run was not able to cleanup, there may be old objects owned by old users.
// So you need to clear things wherever they are stored: locally, hosted, browser cache, ....

// Percent of a normal implementation at which we expect this implemention to write stuff.
const writeSlowdown = (typeof(process) !== 'undefined') ? 0.05 : 1; // My atomic fs writes in node are awful.
const readSlowdown = (typeof(process) !== 'undefined') ? 0.5 : 1;

describe('Flexstore', function () {
  let user, otherUser, team, randomUser;
  const services = []; // fixme ['/', 'https://ki1r0y.com/flex/'];
  const blocks = Array.from({length: 1000 * writeSlowdown}, (_, index) => ({index}));
  beforeAll(async function () {
    Credentials.synchronize(...services);

    // user, otherUser, and randomUser are distinct users authorized on this machine. Only user and otherUser are on team.
    user = Credentials.author = await Credentials.createAuthor('test pin:');
    Credentials.owner = null;
    otherUser = await Credentials.createAuthor('airspeed velocity?');
    team = await Credentials.create(Credentials.author, otherUser);
    randomUser = await Credentials.createAuthor("favorite color?");
  }, 30e3); // !!
  afterAll(async function () {
    await Credentials.destroy({tag: randomUser, recursiveMembers: true});
    await Credentials.destroy({tag: otherUser, recursiveMembers: true});
    await Credentials.destroy(team);
    await Credentials.destroy({tag: user, recursiveMembers: true});
  });
  it('initializes credentials.', function () {
    expect(user && otherUser && team && randomUser).toBeTruthy();
  });
  function testCollection(collectionType, restoreCheck) {
    let collection;
    const label = collectionType.name;
    describe(label, function () {
      let tag, data = {name: 'Alice', birthday: '01/01'};
      let updateCount = 0, latestUpdate;
      beforeAll(async function () {
	collection = new collectionType({name: 'com.acme.' + label, services});
	collection.itemEmitter.onupdate = event => {
	  updateCount++;
	  latestUpdate = event.detail;
	};
	tag = await collection.store(data); // author/owner is user/null
	expect(updateCount).toBe(1);
	if (label !== 'StateCollection') expect(latestUpdate.protectedHeader.sub).toBe(tag);
	expect(latestUpdate.json).toEqual(data);
      });
      afterAll(async function () {
	updateCount = 0;
	await collection.remove({tag});
	expect(updateCount).toBe(1);
	if (label !== 'StateCollection') expect(latestUpdate.protectedHeader.sub).toBe(tag);
	expect(latestUpdate.json).toBeFalsy();
	const signature = await collection.retrieve(tag);
	expect(signature?.json).toBeUndefined();
	await collection.destroy();
      });
      //beforeEach(function () { collection.debug = false; });
      it('stores.', function () {
	expect(typeof tag).toBe('string');
      });
      it('retrieves.', async function () {
	const verified = await collection.retrieve(tag);
	expect(verified.json).toEqual(data);
      });
      it('lists.', async function () {
	expect(await collection.list()).toEqual([tag]);
      });
      it('finds', async function () {
	expect(await collection.find({name: 'Alice'})).toBe(tag);
      });
      it('cannot be written by a different owner (even with the same data).', async function () {
	// We're not encrypting here, so the data is the data.
	// Depending on type, this may reject or not, but in any case, the original data will not change.
	const options = {tag, author: randomUser};
	await collection.store(data, options).catch(() => null);
	const now = await collection.retrieve(tag);
	const owner = now.protectedHeader.kid;
	expect(now.json).toEqual(data); // still
	expect(owner).toBe(Credentials.author); // still
	expect(owner).not.toBe(randomUser);
      });
      describe('specifying owner', function () {
	let previousOwner, tag2, tag3, options;
	const data = {name: 'Bob', birthday: '02/02'};
	beforeAll(async function () {
	  previousOwner = Credentials.owner;
	  // Store data in whatever tag gets generated as "tag2". Owned by team.
	  Credentials.owner = team;
	  Credentials.encryption = 'team';
	  updateCount = 0;
	  tag2 = await collection.store(data); // store B at tag2 (since reset of updateCount)
	  expect(tag2).not.toBe(tag);
	  if (label === 'StateCollection') {
	    // The way the internal machinery writes to the "same" StatCollection tag is a bit different
	    options = {ant: tag2};
	  } else {
	    options = {tag: tag2};
	  }
	}, 10e3);
	afterAll(async function () {
	  try {
	    await collection.remove({tag: tag2});
	    await collection.remove({tag: tag3, author: otherUser});	 // May be a no-op.
	    expect((await collection.retrieve(tag2))?.json).toBeUndefined();
	    expect((await collection.retrieve(tag3))?.json).toBeUndefined();
	    expect((await collection.list()).length).toBe(1);
	  } finally {
	    Credentials.owner = previousOwner;
	    Credentials.encryption = null;
	  }
	  switch (label) { // We have tried 2 stores and 2 removes, but on the same tag.
	  case 'ImmutableCollection': // The second store and second remove on the same tag are no-ops.
	    expect(updateCount).toBe(2);
	    break;
	  case 'MutableCollection': // The second remove on the same tag is a no-op.
	    expect(updateCount).toBe(3);
	    break;
	  case 'VersionedCollection': // Both stores take. The first delete removes two versions, and the second is a no-op.
	  case 'StateCollection':
	    expect(updateCount).toBe(4);
	    break;
	  default:
	    expect("Missing afterAll case").toBeFalsy();
	  }
	});
	it('team members can re-store', async function () {
	  const newData = Object.assign({}, data, {birthday: '03/03'});
          // Store slightly different data at the same tag2, by a different member of the same team. restoreCheck will check that the right answer wins.
	  tag3 = await collection.store(newData, {author: otherUser, ...options}); // store B2 at tag2 (since reset of update count)
          // Doing this in an immutable data shouldn't actually put the new data/owner,
          // but neither should it reject. It should "succeed" and resolve to the same tag.
	  const verified = await collection.retrieve(tag3);
          Credentials.author = user;
	  expect(verified.protectedHeader.iss).toBe(team);
	  expect(verified.decrypted.protectedHeader.kid).toBe(team); // encrypted for the whole team.
	  await restoreCheck(data, newData, verified, tag2, tag3, collection);
	});
	it('cannot be overwritten by non-team member.', async function () {
	  await collection.store(data, {author: randomUser, owner: randomUser, ...options}).catch(() => null);
	  const now = await collection.retrieve(tag2);
	  const owner = now.protectedHeader.iss;
	  expect(owner).toBe(Credentials.owner); // still
	  expect(owner).not.toBe(randomUser);
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
	    const start = Date.now();
	    let i = 0;
	    for (const datum of blocks)  {
	      tags[i++] = await collection.store(datum);
	    }
	    const elapsed = Date.now() - start;
	    writesPerSecond = blocks.length / (elapsed / 1e3);
	    console.log(label, 'serial writes/second', writesPerSecond);
	  }, 25e3);
	  afterAll(async function () {
	    await Promise.all(tags.map(tag => collection.remove({tag})));
	  }, 14e3);
	  it('writes.', function () {
	    expect(writesPerSecond).toBeGreaterThan(45 * writeSlowdown);
	  });
	  it('reads.', async function () {
	    const start = Date.now();
	    for (const tag of tags)  {
	      await collection.retrieve(tag);
	    }
	    const elapsed = Date.now() - start;
	    const readsPerSecond = blocks.length / (elapsed / 1e3);
	    console.log(label, 'serial reads/second', readsPerSecond);
	    expect(readsPerSecond).toBeGreaterThan(170 * readSlowdown);
	  }, 8e3);
	});
	describe('parallel', function () {
	  let tags = Array(blocks.length), writesPerSecond;
	  beforeAll(async function () {
	    const start = Date.now();
	    tags = await Promise.all(blocks.map(datum => collection.store(datum)));
	    const elapsed = Date.now() - start;
	    writesPerSecond = blocks.length / (elapsed / 1e3);
	    console.log(label, 'parallel writes/second', writesPerSecond);
	  }, 14e3);
	  afterAll(async function () {
	    await Promise.all(tags.map(tag => collection.remove({tag})));
	  }, 13e3);
	  it('writes.', function () {
	    expect(writesPerSecond).toBeGreaterThan(150 * writeSlowdown);
	  });
	  it('reads.', async function () {
	    const start = Date.now();
	    await Promise.all(tags.map(tag => collection.retrieve(tag)));
	    const elapsed = Date.now() - start;
	    const readsPerSecond = blocks.length / (elapsed / 1e3);
	    console.log(label, 'parallel reads/second', readsPerSecond);
	    expect(readsPerSecond).toBeGreaterThan(500 * readSlowdown);
	  });
	}, 15e3);
      });
    });
  }
  // TODO: store stamped earlier than existing should work.
  // TODO: delete after written whould work.
  // TODO: store after delete should work.
  // TODO: delete stamped earlier than existing should fail(?)
  async function expectImmutable(firstData, newData, newVerified, firstTag, newTag) {
    expect(firstTag).toBe(newTag);
    expect(newVerified.json).toEqual(firstData);
    expect(newVerified.protectedHeader.act).toBe(user); // Original user
  }
  function expectMutable(firstData, newData, newVerified, firstTag, newTag) {
    expect(firstTag).toBe(newTag);
    expect(newVerified.json).toEqual(newData);
    expect(newVerified.protectedHeader.act).toBe(otherUser);
  }
  async function expectState(firstData, newData, newVerified, firstTag, newTag) {
    expect(firstTag).not.toBe(newTag);
    expect(newVerified.json).toEqual(newData);
    expect(newVerified.protectedHeader.act).toBe(otherUser);
  }
  testCollection(StateCollection, expectState);
  testCollection(ImmutableCollection, expectImmutable);
  testCollection(MutableCollection, expectMutable);
  testCollection(VersionedCollection, expectMutable);
});
