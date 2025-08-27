import uuid4 from 'uuid4';
import { Credentials, VersionedCollection, StateCollection } from '@kilroy-code/flexstore';
const { describe, beforeAll, afterAll, beforeEach, afterEach, it, expect, expectAsync, URL } = globalThis;

const unique = uuid4();

// TODO: Demonstrate error on double spend.
describe('VersionedCollection', function () {
  let initialData = {foo: 17}, tag, collection, initialItemData;
  let collections = [];
  async function setup(name = 'versionTest') {
    collection = new VersionedCollection({name: name + unique});
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
  }, 10e3);
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
      //const contents = await Promise.all(Object.values(versions).map(hash => collection.versions.retrieve(hash)));
    }, 10e3);
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

  describe("commonState", function() { // This internal method is important to correct system behavior.
    let collection, oldAuthor;
    beforeAll(async function () {
      oldAuthor = Credentials.author;
      Credentials.author = await Credentials.create();
      collection = new StateCollection({name: 'test-states' + unique});
    }, 10e3);
    afterAll(async function () {
      await collection.destroy();
      await Credentials.destroy(Credentials.author);
      Credentials.author = oldAuthor;
    });
    let labels = {};
    function id(tag) { return `${labels[tag]}: ${tag}`; }
    async function checkCommon(states, expected) {
      const [expectedState, ...expectedMessages] = expected;
      expectedMessages.sort();

      const [state, ...verifications] = await collection.commonState(states, id);
      let messages = verifications.map(verification => verification.json.message).filter(Boolean);
      messages.sort();
      expect(state).toBe(expectedState);
      expect(messages).toEqual(expectedMessages);
    }
    describe("basic functionality", function() {
      let S0, S1, S2, S3, S4, S5, S6, S7, S8;

      beforeAll(async function() {
	S0 = await collection.store({});
	S1 = await collection.store({message: "Message-a"}, {ant: S0});
	S2 = await collection.store({message: "Message-b"}, {ant: S1});
	S3 = await collection.store({message: "Message-c"}, {ant: S2});
	S4 = await collection.store({message: "Message-d"}, {ant: S3});
	S5 = await collection.store({message: "Message-e"}, {ant: S4});
	S6 = await collection.store({message: "Message-f"}, {ant: S3});
	S7 = await collection.store({message: "Message-g"}, {ant: S6});
	S8 = await collection.store({message: "Message-h"}, {ant: S7});
	labels[S0] = 'S0';
	labels[S1] = 'S1';
	labels[S2] = 'S2';
	labels[S3] = 'S3';
	labels[S4] = 'S4';
	labels[S5] = 'S5';
	labels[S6] = 'S6';
	labels[S7] = 'S7';
	labels[S8] = 'S8';
      });    

      it("should handle empty input", async function() {
	await checkCommon([], []);
      });

      it("should handle single state", async function() {
	await checkCommon([S3], [S3]);
      });

      describe("linear chains", function () {
	describe("shortest first", function () {
	  it("should find common ancestor", async function() {
	    // Without subset eliminiation, would be [S3, "Message-d", "Message-e"])
	    await checkCommon([S3, S5], [S5]);
	  });
	  it("should find deeper common ancestor", async function() {
	    await checkCommon([S3, S4, S5], [S5]);
	  });
	  it("should handle root state", async function() {
	    // Without subset elemination, be [S0, "Message-a", "Message-b", "Message-c"]
	    await checkCommon([S0, S3], [S3]);
	  });
	  it("should handle states with same ancestor at different depths", async function() {
	    // Without subset elemination, be [S2, "Message-c", "Message-f", "Message-g", "Message-h"]
	    await checkCommon([S2, S8], [S8]);
	  });
	});
	describe("longest earlier", function () {
	  it("should handle root state reversed", async function() {
	    await checkCommon([S3, S0], [S3]);
	  });
	  it("should find common deeper ancestor 2", async function() {
	    await checkCommon([S3, S5, S4], [S5]);
	  });
	  it("handles longest last", async function() {
	    await checkCommon([S4, S3, S2, S1, S0, S5], [S5]);
	  });
	  it("handles longest first", async function() {
	    await checkCommon([S5, S4, S3, S2, S1, S0], [S5]);
	  });
	});
      });

      it("handles identical states", async () => {
	await checkCommon([S4, S4, S4], [S4]);
      });


      it("should find common ancestor for branched states, with oldest as first candidate", async function() {
	await checkCommon([S5, S8, S7], [S3, "Message-d", "Message-e", "Message-f", "Message-g", "Message-h"]);
      });
      it("should find common ancestor for branched states, with newest as first candidate", async function() {
	await checkCommon([S8, S7, S5], [S3, "Message-d", "Message-e", "Message-f", "Message-g", "Message-h"]);
      });


      it("handles immediate divergence after root", async () => {
	const F0 = await collection.store({});
	const F1 = await collection.store({message: 'x'}, {ant: F0});
	const F2 = await collection.store({message: 'y'}, {ant: F0});

	await checkCommon([F1, F2], [F0, 'x', 'y']);
      });

      it("handles a fork after one step", async () => {
	const B0 = await collection.store({});
	const B1 = await collection.store({message: 'root'}, {ant: B0});
	const B2 = await collection.store({message: 'left'}, {ant: B1});
	const B3 = await collection.store({message: 'right'}, {ant: B1});

	await checkCommon([B2, B3], [B1, 'left', 'right']);
      });

      it("handles asymmetric deep paths", async () => {
	const C0 = await collection.store({});
	let C = C0;
	for (let i = 1; i <= 10; i++) {
	  C = await collection.store({message: `L${i}`}, {ant: C});
	}
	const leftDeep = C;

	let R = C0;
	for (let i = 1; i <= 3; i++) {
	  R = await collection.store({message: `R${i}`}, {ant: R});
	}
	const rightShallow = R;

	await checkCommon([leftDeep, rightShallow], [C0, 'L1','L2','L3','L4','L5','L6','L7','L8','L9','L10', 'R1','R2','R3']);
      });

      it("handles branches from a deep shared ancestor", async () => {
	const D0 = await collection.store({});
	const D1 = await collection.store({message: 'start'}, {ant: D0});
	const D2 = await collection.store({message: 'step1'}, {ant: D1});
	const D3 = await collection.store({message: 'step2'}, {ant: D2});

	const D4a = await collection.store({message: 'A'}, {ant: D3});
	const D4b = await collection.store({message: 'B'}, {ant: D3});
	const D4c = await collection.store({message: 'C'}, {ant: D3});

	await checkCommon([D4a, D4b, D4c], [D3, 'A', 'B', 'C']);
      });
      it("should handle states with empty messages", async function() {
	const root = await collection.store({});
	const child1 = await collection.store({message: ""}, {ant: root});
	const child2 = await collection.store({message: "non-empty"}, {ant: root});

	await checkCommon([child1, child2], [root, 'non-empty']);
      });
      it("should handle states with no common ancestor", async function() {
	// Create two separate chains with different roots
	const root1 = await collection.store({message: "root1"});
	const node1 = await collection.store({message: "intermediate-msg"}, {ant: root1});
	const chain1 = await collection.store({message: "chain1-msg"}, {ant: node1});

	const root2 = await collection.store({action: "root2"});
	const node2 = await collection.store({message: "intermediate-msg"}, {ant: root2});
	const chain2 = await collection.store({message: "chain2-msg"}, {ant: node2});

	const result = await collection.commonState([chain1, chain2]);
	expect(result).toEqual([]);
      });

    });

    describe("message collection", function() {
      let S0, S1, S2, S3, S4;

      beforeEach(async function() {
	S0 = await collection.store({});
	S1 = await collection.store({message: "msg1"}, {ant: S0});
	S2 = await collection.store({message: "msg2"}, {ant: S1});
	S3 = await collection.store({message: "msg3"}, {ant: S1});
	S4 = await collection.store({message: "msg4"}, {ant: S3});
      });

      it("should collect unique messages only", async function() {
	await checkCommon([S2, S4], [S1, "msg2", "msg3", "msg4"]);
      });

      it("should not include messages from the common state itself", async function() {
	await checkCommon([S2, S4], [S1, "msg2", "msg3", "msg4"]); // but not "msg1"
      });
    });

    describe("performance characteristics", function() {
      let deepStates, collection;
      class StateTrackingAccess extends StateCollection {
	static accesses = 0;
	retrieve(...args) {
	  this.constructor.accesses++;
	  return super.retrieve(...args);
	}
      }

      beforeAll(async function() {
	// Create a deep chain: S99 -> ... S2 -> S1 -> S0
	collection = new StateTrackingAccess({name: 'tracking' + unique});
	deepStates = [];
	deepStates[0] = await collection.store({message: "root"});

	for (let i = 1; i < 100; i++) {
          deepStates[i] = await collection.store({message: `deep-${i}`}, {ant: deepStates[i-1]});
	}
      });
      afterAll(async function () {
	await collection.destroy();
      });

      it("should minimize antecedentState accesses for deep states", async function() {
	// Test with states at various depths, common ancestor is near root
	StateTrackingAccess.accesses = 0;
	const [result] = await collection.commonState([deepStates[50], deepStates[99]]);

	expect(result).toBe(deepStates[99]);
	expect(StateTrackingAccess.accesses).toBeLessThanOrEqual(50); // Should be much less than 50 + 99 = 149 full traversals
      });

      it("should be efficient when common ancestor is near the surface", async function() {
	// Test with states at depth 50 and 99 - common ancestor at depth 50
	StateTrackingAccess.accesses = 0;
	const [result] = await collection.commonState([deepStates[10], deepStates[50], deepStates[99]]);

	expect(result).toBe(deepStates[99]);
	expect(StateTrackingAccess.accesses).toBeLessThan(150);
      });
    });
  });

  describe("'put' merging", function () {
    function mergeTest(label) {
      let suffix = label+unique;
      describe(label, function () {
	let singleData = "single", singleTag, singleHash, singleVersionSignature, singleTimestampsSignature, singleTimestamp;
	let tripleTag, tripleSignatureA, tripleSignatureB;
	let collection, copyA, copyB, copyC, merged, mergedTimestamps;
	let author, other, team, owner, restricted;

	// Make a new collection, and copy the "single" data (state and current hash marker) over to the new copy.
	// Then store something in the copy so that singleTag locally has a version with name
	async function copyAndAddOne(name, signingOptions) {
	  const copy = new VersionedCollection({name: name + suffix});
	  await copy.versions.put(singleHash, singleVersionSignature);
	  await copy.put(singleTag, singleTimestampsSignature, true);
	  await copy.store(name, {tag: singleTag, ...signingOptions});
	  return copy;
	}

	// Copy the single states (not the current hash marker) from source collection to destination collection, and return the last timestamp.
	async function copyVersions(source, destination) {
	  let versions = await source.getVersions(singleTag);
	  for (const time of await source.retrieveTimestamps(singleTag)) {
	    const hash = versions[time];
	    destination.versions.put(hash, await source.versions.get(hash));
	  }
	  return versions.latest;
	}

	beforeAll(async function () {
	  // In these tests:
	  // - author is always the original author of the material.
	  // - owner is the original owner of the material, of which author is idential or a member. (We test both ways.)
	  // - other is someone else that the material passes through, who neither owner nor a member of owner.
	  author = Credentials.author = await Credentials.create();
	  team = await Credentials.create(author);
	  owner = label === 'team' ? team : author;
	  let constructionOptions = {author, owner};
	  other = await Credentials.create(); // Not owner.
	  restricted = new Set([other]);
	  Credentials.encryption = 'owner';

	  collection = new VersionedCollection({name: 'initial' + suffix});
	  singleTag = await collection.store(singleData, constructionOptions);    // The toplevel tag at which we stored "single" in collection.
	  const singleVersions = await collection.getVersions(singleTag);     // Originally just one version.
	  singleTimestamp = singleVersions.latest;                            // At this timestamp.
	  singleHash = singleVersions[singleTimestamp];                       // Internally stored in collection.versions at this hash.
	  singleVersionSignature = await collection.versions.get(singleHash); // The signature of that stored version.
	  singleTimestampsSignature = await collection.get(singleTag);        // The signature of timestamp map.

	  // Like single, but beginning with three stores, of value 1, 2, and 3.
	  let counter = 1;
	  tripleTag = await collection.store(counter, constructionOptions);
	  await collection.store(++counter, {tag: tripleTag, ...constructionOptions});
	  tripleSignatureA = await collection.get(tripleTag);
	  await collection.store(++counter, {tag: tripleTag, ...constructionOptions});
	  tripleSignatureB = await collection.get(tripleTag);

	  // Each copy begins with the same single entry, and then stores another version at singleTag, with the given name.
	  // Each copy thus has two versions at singleTag, where the second version is a different value and timestamp for each copy.
	  copyA = await copyAndAddOne('copyA', constructionOptions);
	  copyB = await copyAndAddOne('copyB', constructionOptions);
	  copyC = await copyAndAddOne('copyC', constructionOptions);

	  // Now merge all three into a new empty copy called 'merged'.
	  merged = new VersionedCollection({name: 'merged' + suffix});
	  mergedTimestamps = [
	    singleTimestamp,
	    await copyVersions(copyA, merged),
	    await copyVersions(copyB, merged),
	    await copyVersions(copyC, merged),
	  ];
	  // Just for fun, let's put the second one first.
	  await merged.put(singleTag, await copyB.get(singleTag), true);
	  await merged.put(singleTag, await copyA.get(singleTag), true);
	  await merged.put(singleTag, await copyC.get(singleTag), true);

	  Credentials.author = other;
	}, 20e3);
	afterAll(async function () {
	  await collection.destroy();
	  await copyA.destroy();
	  await copyB.destroy();
	  await copyC.destroy();
	  await merged.destroy();
	  Credentials.author = null;
	  Credentials.encryption = null;
	  await Credentials.destroy(other);
	  await Credentials.destroy(team);
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
	    const copy = new VersionedCollection({name: 'copy-keep-first' + suffix});
	    await copy.versions.put(singleHash, singleVersionSignature);
	    await copy.put(singleTag, singleTimestampsSignature, true);
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
	    const copy = new VersionedCollection({name: 'copy-keep-last' + suffix});
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
	    const copy = new VersionedCollection({name: 'copy-keep-fiirst' + suffix});
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
	    const latestCopyAVerified = await copyA.retrieve(singleTag);
	    expect(latestCopyAVerified.protectedHeader.encryption).toBe(owner);
	    expect(latestCopyAVerified.protectedHeader.cty).toContain('encrypted');

	    const nonMemberHolding = new VersionedCollection({name: 'nonMemberHolding' + suffix});
	    nonMemberHolding.restrictedTags = restricted;
	    await copyVersions(copyA, nonMemberHolding);
	    await copyVersions(copyB, nonMemberHolding);
	    await copyVersions(copyC, nonMemberHolding);
	    // Just for fun, let's put the second one first.
	    await nonMemberHolding.put(singleTag, await copyB.get(singleTag), true);
	    await nonMemberHolding.put(singleTag, await copyA.get(singleTag), true);
	    await nonMemberHolding.put(singleTag, await copyC.get(singleTag), true);

	    // The nonMemberHolding result is in limbo. It does not have one single merged set of timestamps.
	    // But we can confirm that it has not been anonymously merged:
	    const stateVerification = await nonMemberHolding.getVerified(singleTag);
	    const states = stateVerification.json;
	    expect(await nonMemberHolding.getOwner(stateVerification.protectedHeader)).toBe(owner);
	    expect(states.length).toBe(3); // nonmember merge of a, b, and c.

	    // And we can merge it properly with authorization.
	    Credentials.author = author;
	    delete nonMemberHolding.restrictedTags;
	    await nonMemberHolding.put(singleTag, stateVerification.signature, true); // An owner jiggles the handle.
	    const restatedVerification = await nonMemberHolding.getVerified(singleTag);
	    expect(restatedVerification.json.length).toBe(1);
	    expect(await nonMemberHolding.retrieveTimestamps(singleTag)).toEqual(mergedTimestamps);
	    expect((await nonMemberHolding.retrieve(singleTag)).text).toBe('copyC');

	    const currentStateVerification = await nonMemberHolding.retrieve(singleTag);
	    expect(currentStateVerification.protectedHeader.encryption).toBe(owner);
	    expect(currentStateVerification.protectedHeader.cty).toContain('encrypted');

	    Credentials.author = null;

	    await nonMemberHolding.destroy();
	  }, 10e3);
	});
      });
    }
    mergeTest('author');
    mergeTest('team');
  });
});
