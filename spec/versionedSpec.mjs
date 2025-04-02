import { Credentials, ImmutableCollection, MutableCollection, VersionedCollection } from '../index.mjs';
const { describe, beforeAll, afterAll, it, expect, expectAsync, URL } = globalThis;

describe('VersionedCollection', function () {
  let initialData = {foo: 17}, tag, collection = new VersionedCollection({name: 'test'}), initialItemData;
  beforeAll(async function () {
    tag = Credentials.author = await Credentials.create();
    let stored = await collection.store(initialData, {tag});
    expect(stored).toBe(tag);
    initialItemData = await collection.retrieve(tag);
  });
  afterAll(async function () {
    await collection.remove(tag);
    await Credentials.destroy(Credentials.author);
    await collection.destroy();
  });

  describe('extended retrieval options', function () {
    let timestamps, versions;
    beforeAll(async function () {
      timestamps = await collection.retrieveTimestamps(tag);
      if (timestamps.length < 2) {
	await collection.store('something', tag);
	timestamps = await collection.retrieveTimestamps(tag);
      }
      versions = await collection.getVersions(tag);
    });
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

    describe('version lookup', function () {
      it('can be by exact timestamp.', async function () {
	const historicalData = await Promise.all(timestamps.map(time => collection.retrieve({tag, time})));
	const lastHistorical = historicalData[historicalData.length - 1];
	const latestData = await collection.retrieve({tag}); // No time specified.
	expect(historicalData.every(validation => typeof(validation.text))).toBeTruthy();
	expect(historicalData[0].json).toEqual(initialData);
	expect(lastHistorical.text).toEqual(latestData.text);
	expect(historicalData.every((validation, index) => validation.protectedHeader.iat === timestamps[index])).toBeTruthy();
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
    it('is initial numeric.', function () {
      const {ant} = initialItemData.protectedHeader; // Antecedent is the 'ant' header.
      expect(typeof ant).toBe('number');
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
      expect(latest.text).toBe(preceding.text);   // ...even for the same data being written.
      expect(latest.text).toBe(data);
    });
  });

  describe("'put' merging", function () {
    let singleData = "single", singleTag, singleHash, singleVersionSignature, singleTimestampsSignature, singleTimestamp;
    let tripleTag, tripleSignatureA, tripleSignatureB;
    let copyA, copyB, timestampA, timestampB, merged;
    beforeAll(async function () {
      let author = await Credentials.create(), owner = author;

      singleTag = await collection.store(singleData, {author, owner});
      const singleVersions = await collection.getVersions(singleTag);
      singleTimestamp = singleVersions.latest;
      singleHash = singleVersions[singleTimestamp];
      singleVersionSignature = await collection.versions.get(singleHash);
      singleTimestampsSignature = await collection.get(singleTag);
      
      let counter = 1;
      tripleTag = await collection.store(counter, {author, owner});
      await collection.store(++counter, {author, owner, tag: tripleTag});
      tripleSignatureA = await collection.get(tripleTag);
      await collection.store(++counter, {author, owner, tag: tripleTag});
      tripleSignatureB = await collection.get(tripleTag);


      console.log(`starting merge ${singleTag}, with ${singleHash} @ ${singleTimestamp}`);
      merged = new VersionedCollection({name: 'merged'});

      copyA = new VersionedCollection({name: 'copyA'});
      await copyA.versions.put(singleHash, singleVersionSignature);
      console.log('put first in A');
      await copyA.put(singleTag, singleTimestampsSignature);
      console.log('store second in A, over', await copyA.getVersions(singleTag));
      await copyA.store('dataA', {author, owner, tag: singleTag});
      const versionsA = await copyA.getVersions(singleTag);
      console.log('final A versions', versionsA);
      for (const time of await copyA.retrieveTimestamps(singleTag)) {
	const hash = versionsA[time];
	timestampA = time;
	merged.versions.put(hash, await copyA.versions.get(hash));
      }
      copyB = new VersionedCollection({name: 'copyB'});
      await copyB.versions.put(singleHash, singleVersionSignature);
      console.log('put first in B');      
      await copyB.put(singleTag, singleTimestampsSignature);
      console.log('store second in B, over', await copyB.getVersions(singleTag));
      await copyB.store('dataB', {author, owner, tag: singleTag});                     // why is dataB producing the same has as dataA above.
      const versionsB = await copyB.getVersions(singleTag);
      console.log('final B versions', versionsB);
      for (const time of await copyB.retrieveTimestamps(singleTag)) {
	const hash = versionsB[time];
	timestampB = time;	
	merged.versions.put(hash, await copyB.versions.get(hash));
      }
      // FIXME: Just for fun, let's put the second one first.
      console.log('store put A in merged');      
      await merged.put(singleTag, await copyA.get(singleTag));
      console.log('store put B in merged');
      await merged.put(singleTag, await copyB.get(singleTag));
					
      await Credentials.destroy(author);
    });
    afterAll(async function () {
      await copyA.destroy();
      await copyB.destroy();
    });
    describe('with owner credentials', function () {
      it('creates the union of one history on top of another.', async function () {
	expect(await merged.retrieveTimestamps(singleTag)).toEqual([singleTimestamp, timestampA, timestampB]);
      });
      it('create the union of multiple separate histories (e.g., as produced by relays that have no ownership).', async function () {
      });
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
      });
    });
  });
});
