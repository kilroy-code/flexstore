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
    let copyA, copyB, copyC, merged, mergedTimestamps;
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

      copyA = await copyAndAddOne('copyA', author, owner);
      copyB = await copyAndAddOne('copyB', author, owner);
      copyC = await copyAndAddOne('copyC', author, owner);

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
					
      await Credentials.destroy(author);
    });
    afterAll(async function () {
      await copyA.destroy();
      await copyB.destroy();
      await copyC.destroy();
      await merged.destroy();
    });
    describe('with owner credentials', function () {
      it('creates the union of one history on top of another.', async function () {
	expect(await merged.retrieveTimestamps(singleTag)).toEqual(mergedTimestamps);
	expect((await merged.retrieve(singleTag)).text).toBe('copyC');
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

	// Just like in the signed merged, except that we now have no credentials
	// Internally, the signature is in two separate, individually signed parts.
	const unsignedMerged = new VersionedCollection({name: 'unsignedMerged'});
	await copyVersions(copyA, unsignedMerged);
	await copyVersions(copyB, unsignedMerged);
	await copyVersions(copyC, unsignedMerged);
	// Just for fun, let's put the second one first.
	await unsignedMerged.put(singleTag, await copyB.get(singleTag));
	await unsignedMerged.put(singleTag, await copyA.get(singleTag));
	await unsignedMerged.put(singleTag, await copyC.get(singleTag));

	expect(await unsignedMerged.retrieveTimestamps(singleTag)).toEqual(mergedTimestamps);
	expect((await unsignedMerged.retrieve(singleTag)).text).toBe('copyC');
	// But we can confirm that it has not been anonymously merged:
	const timestampSignature = await unsignedMerged.get(singleTag);
	const timestamps = JSON.parse(timestampSignature);
	expect(timestamps.length).toBe(3); // unsigned merge of a, b, and c.
	const [a, b] = await Promise.all(timestamps.map(signature => Credentials.verify(signature)));
	expect(a.json).toBeInstanceOf(Object);
	expect(b.json).toBeInstanceOf(Object);
	expect(a.protectedHeader.iat).not.toBe(b.protectedHeader.iat);
	await unsignedMerged.destroy();
      });
    });
  });
});
