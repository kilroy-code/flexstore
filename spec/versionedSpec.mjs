import { Credentials, VersionedXCollection as VersionedCollection } from '@kilroy-code/flexstore';
const { describe, beforeAll, afterAll, beforeEach, afterEach, it, expect, expectAsync, URL } = globalThis;

// TODO: Demonstrate error on double spend.
describe('VersionedCollection', function () {
  let initialData = {foo: 17}, tag, collection, initialItemData;
  let collections = [];
  async function setup(name = 'versionTest') {
    collection = new VersionedCollection({name});
    collections.push(collection);
    tag = Credentials.author = await Credentials.create();
    let stored = await collection.store(initialData, {tag});
    expect(stored).toBe(tag);
    initialItemData = await collection.retrieve(tag);
    return [collection, tag, initialItemData];
  }
  let tagToBeCleaned1;
  beforeAll(async function () {
    [collection, tag, initialItemData] = await setup();
    tagToBeCleaned1 = tag;
  });
  afterAll(async function () {
    for (collection of collections) {
      await collection.destroy();
    }
    await Credentials.destroy(tagToBeCleaned1);
  }, 15e3); // As much as five seconds per separate collection?

  describe('extended retrieval options', function () {
    let timestamps, versions;
    let tag, collection, initialItemData;
    let tagToBeCleaned2;
    beforeAll(async function () {
      [collection, tag, initialItemData] = await setup('retrievalTests');
      tagToBeCleaned2 = tag;
      timestamps = await collection.retrieveTimestamps(tag);
      if (timestamps.length < 2) {
	await collection.store('something', tag);
	timestamps = await collection.retrieveTimestamps(tag);
      }
      versions = await collection.getVersions(tag);
      const contents = await Promise.all(Object.values(versions).map(hash => collection.versions.retrieve(hash)));
    });
    afterAll(async function () {
      await Credentials.destroy(tagToBeCleaned2);
    });
    describe('metadata', function () {
      it('timestamps is a list of timestamps.', function () {
	expect(timestamps).toBeInstanceOf(Array);
	expect(timestamps.every(time => typeof(time) === 'number')).toBeTruthy();
      });
      it('versions is an object mapping timestamps to (mostly) hashes.', function () {
	expect(versions).toBeInstanceOf(Object);
	const timeKeys = Object.keys(versions);
	const hashes = Object.values(versions).slice(1); // Skipping the first one, which the latest timestamp.
	expect(timeKeys.every(time => typeof(time) === 'string')).toBeTruthy();
	expect(hashes.every(hash => typeof(hash) === 'string')).toBeTruthy();
      });
      it('version has a "latest" that is a timestamp.', function () {
	expect(versions.latest).toBe(timestamps[timestamps.length - 1]);
      });
    });

    describe('version lookup', function () {
      it('can be by hash.', async function () {
	const times = Object.keys(versions).slice(1); // Ommitting 'latest'
	const hashes = Object.values(versions).slice(1);
	const byTime = await Promise.all(times.map(time => collection.retrieve({tag, time})));
	const byHash = await Promise.all(hashes.map(hash => collection.retrieve({tag, hash})));
	const byInternal = await Promise.all(hashes.map(hash => collection.versions.retrieve({tag: hash})));
	byTime.forEach((timeResult, index) => expect(timeResult.text).toBe(byHash[index].text));
	byHash.forEach((hashResult, index) => expect(hashResult.text).toBe(byInternal[index].text));
      });
      it('can be by exact timestamp.', async function () {
	const historicalData = await Promise.all(timestamps.map(time => collection.retrieve({tag, time})));
	const historicalStamps = historicalData.map(validation => validation.protectedHeader.iat);
	expect(historicalStamps).toEqual(timestamps);
	const lastHistorical = historicalData[historicalData.length - 1];
	const latestData = await collection.retrieve({tag}); // No time specified.
	expect(historicalData[0].json).toEqual(initialData);
	expect(lastHistorical.text).toEqual(latestData.text);
	expect(historicalData.every(validation => typeof(validation.text))).toBeTruthy();
      });
      it('can be before the first write, but will produce no result.', async function () {
	expect(await collection.retrieve({tag, time: timestamps[0] - 1})).toBeFalsy();
      });
      it('can be after the last as the last write, and will repeat last result.', async function () {
	const last = await collection.retrieve({tag, time: versions.latest});
	const after = await collection.retrieve({tag, time: versions.latest + 1});
	expect(last.text).toBe(after.text);
      });
      it('can be between times and will produce the version in place at that time.', async function () {
	const t0 = timestamps[0];
	const t1 = timestamps[1];
	const tHalf = t0 + (t1 - t0) / 2;
	const dataHalf = await collection.retrieve({tag, time: tHalf});
	expect(dataHalf.text).toBe(initialItemData.text);
	expect(dataHalf.protectedHeader.iat).toBe(t0);
      });
    });
  });

  describe('antecedent', function () {
    let collection, tag, initialItemData;
    let tagToBeCleaned3;
    beforeAll(async function () {
      [collection, tag, initialItemData] = await setup('antecedentTest');
      tagToBeCleaned3 = tag;
    });
    afterAll(async function () {
      await Credentials.destroy(tagToBeCleaned3);
    });
    it('is initially falsy.', function () {
      const {ant, iat} = initialItemData.protectedHeader; // Antecedent is the 'ant' header.
      expect(ant).toBeFalsy();
    });
    it('is thereafter the string tag of the previous version.', async function () {
      const existing = await collection.retrieve(tag);
      await collection.store({foo: 18}, tag);
      const verified = await collection.retrieve(tag);
      const {ant, iat} = verified.protectedHeader;
      expect(typeof ant).toBe('string');
      // Now figure out what the preceding item hash was, the hard way.
      const times = await collection.retrieveTimestamps(tag);
      const versions = await collection.getVersions(tag);
      const index = times.indexOf(iat);
      const precedingIndex = index - 1;
      const precedingTimestamp = times[index - 1];
      const hash = versions[precedingTimestamp];
      expect(ant).toBe(hash); // The antecedent is just that hash.
    });
    it('is used in the hash, so that each version hash is unique.', async function () {
      const data = "foo";
      await collection.store(data, tag);
      await collection.store(data, tag); // identical
      // And yet two different versions get written: two timestamps to do different hashes.
      const versions = await collection.getVersions(tag);
      const times = Object.keys(versions);
      const latestTime = versions.latest;
      const latestIndex = times.indexOf(latestTime.toString());
      const precedingIndex = latestIndex - 1;
      const precedingTime = times[precedingIndex];
      const latestHash = versions[latestTime];
      const precedingHash = versions[precedingTime];
      const latest = await collection.retrieve({tag, time: latestTime});
      const preceding = await collection.retrieve({tag, time: precedingTime});
      expect(typeof latestHash).toBe('string');
      expect(typeof precedingHash).toBe('string');
      expect(latestHash).not.toBe(precedingHash); // Each has is different...
      expect(latest.text).toEqual(preceding.text);   // ...even for the same data being written.
      expect(latest.text).toEqual(data);
    });
  });

  xdescribe("'put' merging", function () {
    let singleData = "single", singleTag, singleHash, singleVersionSignature, singleTimestampsSignature, singleTimestamp;
    let tripleTag, tripleSignatureA, tripleSignatureB;
    let copyA, copyB, copyC, merged, mergedTimestamps;
    let author, other;
    async function copyAndAddOne(name, author, owner) { // Copy the "single" data over to a new copy, and then store something in the copy.
      const copy = new VersionedCollection({name});
      await copy.versions.put(singleHash, singleVersionSignature);
      await copy.put(singleTag, singleTimestampsSignature);
      await copy.store(name, {author, owner, tag: singleTag});
      return copy;
    }
    async function copyVersions(source, destination) { // copy versions from source to destination, and return the last timestamp.
      let versions = await source.getVersions(singleTag);
      for (const time of await source.retrieveTimestamps(singleTag)) {
	const hash = versions[time];
	destination.versions.put(hash, await source.versions.get(hash));
      }
      return versions.latest;
    }

    beforeAll(async function () {
      author = Credentials.author = await Credentials.create();
      let owner = author;
      other = await Credentials.create(); // Not owner.

      singleTag = await collection.store(singleData, {author, owner});    // The toplevel tag at which we stored "single" in collection.
      const singleVersions = await collection.getVersions(singleTag);     // Originally just one version.
      singleTimestamp = singleVersions.latest;                            // At this timestamp.
      singleHash = singleVersions[singleTimestamp];                       // Internally stored in collection.versions at this hash.
      singleVersionSignature = await collection.versions.get(singleHash); // The signature of that stored version.
      singleTimestampsSignature = await collection.get(singleTag);        // The signature of timestamp map.

      let counter = 1;
      tripleTag = await collection.store(counter, {author, owner});
      await collection.store(++counter, {author, owner, tag: tripleTag});
      tripleSignatureA = await collection.get(tripleTag);
      await collection.store(++counter, {author, owner, tag: tripleTag});
      tripleSignatureB = await collection.get(tripleTag);

      // Each copy begins with the same single entry, and then stores another version at singleTag, with the given name.
      // Each copy thus has two versions at singleTag, where the second version is a different value and timestamp for each copy.
      copyA = await copyAndAddOne('copyA', author, owner);
      copyB = await copyAndAddOne('copyB', author, owner);
      copyC = await copyAndAddOne('copyC', author, owner);

      // Now merge all three into a new empty copy called 'merged'.
      merged = new VersionedCollection({name: 'merged'});
      mergedTimestamps = [
	singleTimestamp,
	await copyVersions(copyA, merged),
	await copyVersions(copyB, merged),
	await copyVersions(copyC, merged),
      ];
      // Just for fun, let's put the second one first.
      await merged.put(singleTag, await copyB.get(singleTag));
      await merged.put(singleTag, await copyA.get(singleTag));
      await merged.put(singleTag, await copyC.get(singleTag));

      Credentials.author = other;
    }, 20e3);
    afterAll(async function () {
      await copyA.destroy();
      await copyB.destroy();
      await copyC.destroy();
      await merged.destroy();
      Credentials.author = null;
      await Credentials.destroy(other);
      await Credentials.destroy(author);
    }, 20e3);
    describe('with owner credentials', function () {
      it('creates the union of one history on top of another.', async function () {
	const timestamps = await merged.retrieveTimestamps(singleTag);
	const latest = await merged.retrieve(singleTag);
	expect(timestamps).toEqual(mergedTimestamps);
	expect(latest.text).toBe('copyC');
      });
      // it('create the union of multiple separate histories (e.g., as produced by relays that have no ownership).', async function () {
      // });
    });
    describe('without requiring owner credentials', function () {
      it('keeps the first version.', async function () {
	const copy = new VersionedCollection({name: 'copy'});
	await copy.versions.put(singleHash, singleVersionSignature);
	await copy.put(singleTag, singleTimestampsSignature);
	const retrieved = await copy.retrieve(singleTag);
	const copyStamps = await copy.retrieveTimestamps(singleTag);
	expect(singleTimestamp).toBe(retrieved.protectedHeader.iat);
	expect(await copy.retrieveTimestamps(singleTag)).toEqual([retrieved.protectedHeader.iat]);
	expect(retrieved.text).toBe(singleData);
	await copy.destroy();
      });
      it('keeps the newer superset when put last.', async function () {
	const versions = await collection.getVersions(tripleTag);
	const timestamps = await collection.retrieveTimestamps(tripleTag);
	const copy = new VersionedCollection({name: 'copy'});
	for (let time of timestamps) {
	  const hash = versions[time];
	  await copy.versions.put(hash, await collection.versions.get(hash));
	}
	await copy.put(tripleTag, tripleSignatureA);
	expect((await copy.retrieveTimestamps(tripleTag)).length).toBe(2);

	await copy.put(tripleTag, tripleSignatureB);
	expect((await copy.retrieveTimestamps(tripleTag)).length).toBe(3);

	expect(await copy.getVersions(tripleTag)).toEqual(versions);
	expect((await copy.retrieve(tripleTag)).text).toBe('3');

	await copy.destroy();	
      });
      it('keeps the newer superset when put first.', async function () {
	// Same as above, but 'put'ting the final timestamp set first.
	const versions = await collection.getVersions(tripleTag);
	const timestamps = await collection.retrieveTimestamps(tripleTag);
	const copy = new VersionedCollection({name: 'copy'});
	for (let time of timestamps) {
	  const hash = versions[time];
	  await copy.versions.put(hash, await collection.versions.get(hash));
	}
	await copy.put(tripleTag, tripleSignatureB);
	expect((await copy.retrieveTimestamps(tripleTag)).length).toBe(3);

	await copy.put(tripleTag, tripleSignatureA); // keeps B
	expect((await copy.retrieveTimestamps(tripleTag)).length).toBe(3);

	expect(await copy.getVersions(tripleTag)).toEqual(versions);
	expect((await copy.retrieve(tripleTag)).text).toBe('3');

	await copy.destroy();
	
      });
      it('keeps multiple histories separate when they conflict.', async function () {

	// Just like in the signed merged, except that we now explicitly use a non-member's credentials,
	// as would be the case on a relay server.
	// Internally, the signature is in two separate, individually signed parts.
	const nonMemberHolding = new VersionedCollection({name: 'nonMemberHolding'});
	await copyVersions(copyA, nonMemberHolding);
	await copyVersions(copyB, nonMemberHolding);
	await copyVersions(copyC, nonMemberHolding);
	// Just for fun, let's put the second one first.
	await nonMemberHolding.put(singleTag, await copyB.get(singleTag), null, other);
	await nonMemberHolding.put(singleTag, await copyA.get(singleTag), null, other);
	await nonMemberHolding.put(singleTag, await copyC.get(singleTag), null, other);

	// The nonMemberHolding result is in limbo. It does not have one signal merged set of timestamps.
	// But we can confirm that it has not been anonymously merged:
	const timestampVerification = await nonMemberHolding.getVerified(singleTag);
	const timestamps = timestampVerification.json;
	expect(timestamps.length).toBe(3); // nonmember merge of a, b, and c.
	const [a, b] = await Promise.all(timestamps.map(signature => Credentials.verify(signature)));
	expect(a.json).toBeInstanceOf(Object);
	expect(b.json).toBeInstanceOf(Object);
	expect(a.protectedHeader.iat).not.toBe(b.protectedHeader.iat);
	// And we can get it to combine timestamps for us without persisting.
	expect(await nonMemberHolding.retrieveTimestamps(singleTag)).toEqual(mergedTimestamps);
	expect((await nonMemberHolding.retrieve(singleTag)).text).toBe('copyC');

	// And we can merge it properly with authorization.
	Credentials.author = author;
	await nonMemberHolding.put(singleTag, timestampVerification.signature);
	expect(await nonMemberHolding.retrieveTimestamps(singleTag)).toEqual(mergedTimestamps);
	expect((await nonMemberHolding.retrieve(singleTag)).text).toBe('copyC');
	Credentials.author = null;

	await nonMemberHolding.destroy();
      }, 10e3);
    });
  });
});
