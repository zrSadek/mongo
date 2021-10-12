/**
 * Verifies that it is possible to upgrade a replica set with collections with 'recordPreImages'
 * option to use 'changeStreamPreAndPostImages' option, and to do a corresponding downgrade.
 * @tags: [requires_fcv_51, featureFlagChangeStreamPreAndPostImages]
 */
(function() {
'use strict';

load("jstests/libs/collection_drop_recreate.js");  // For assertCreateCollection.
load("jstests/libs/collection_options.js");        // For assertCollectionOptionIsEnabled,
                                                   // assertCollectionOptionIsAbsent.
load("jstests/multiVersion/libs/multi_rs.js");     // For upgradeSet.
load(
    "jstests/libs/change_stream_util.js");  // For
                                            // assertChangeStreamPreAndPostImagesCollectionOptionIsEnabled,
                                            // assertChangeStreamPreAndPostImagesCollectionOptionIsAbsent.

const collName = "test";

function runTest(downgradeVersion) {
    const downgradeFCV = binVersionToFCV(downgradeVersion);

    const rst = new ReplSetTest({
        nodes: 2,
        nodeOptions: {binVersion: downgradeVersion},
    });
    rst.startSet();
    rst.initiate();

    // Create the collection with recorded pre-images enabled.
    let testDB = rst.getPrimary().getDB(jsTestName());
    assertCreateCollection(testDB, collName, {"recordPreImages": true});

    // Upgrade the replica set.
    rst.upgradeSet({binVersion: "latest"});
    testDB = rst.getPrimary().getDB(jsTestName());

    // Set the FCV to the latest.
    testDB.adminCommand({setFeatureCompatibilityVersion: latestFCV});

    // 'changeStreamPreAndPostImages' option must be absent and 'recordPreImages' option must be set
    // to true.
    assertCollectionOptionIsEnabled(testDB, collName, "recordPreImages");
    assertChangeStreamPreAndPostImagesCollectionOptionIsAbsent(testDB, collName);

    // Enable pre-/post-images for the collection with "recordPreImages" enabled.
    assert.commandWorked(
        testDB.runCommand({"collMod": collName, "changeStreamPreAndPostImages": {enabled: true}}));

    // 'changeStreamPreAndPostImages' option must be enabled and 'recordPreImages' should be absent.
    assertCollectionOptionIsAbsent(testDB, collName, "recordPreImages");
    assertChangeStreamPreAndPostImagesCollectionOptionIsEnabled(testDB, collName);

    // Set 'recordPreImages: true' to disable 'changeStreamPreAndPostImages' option.
    assert.commandWorked(testDB.runCommand({"collMod": collName, "recordPreImages": true}));

    // 'changeStreamPreAndPostImages' option must be absent and 'recordPreImages' should be set to
    // true.
    assertCollectionOptionIsEnabled(testDB, collName, "recordPreImages");
    assertChangeStreamPreAndPostImagesCollectionOptionIsAbsent(testDB, collName);

    // Downgrade the FCV.
    testDB.adminCommand({setFeatureCompatibilityVersion: downgradeFCV});

    // Verify that an attempt to set 'changeStreamPreAndPostImages' option fails for the downgrade
    // version.
    assert.commandFailedWithCode(
        testDB.createCollection(collName, {"changeStreamPreAndPostImages": {enabled: false}}),
        5846900);
    assert.commandFailedWithCode(
        testDB.runCommand({"collMod": collName, "changeStreamPreAndPostImages": {enabled: false}}),
        5846901);

    // Downgrade the cluster.
    rst.upgradeSet({binVersion: downgradeVersion});

    // Reset the db reference.
    testDB = rst.getPrimary().getDB(jsTestName());

    // 'changeStreamPreAndPostImages' option must be absent and 'recordPreImages' should be set to
    // true.
    assertCollectionOptionIsEnabled(testDB, collName, "recordPreImages");
    assertChangeStreamPreAndPostImagesCollectionOptionIsAbsent(testDB, collName);

    // Upgrade the replica set.
    rst.upgradeSet({binVersion: "latest"});
    testDB = rst.getPrimary().getDB(jsTestName());

    // Set the FCV to the latest.
    testDB.adminCommand({setFeatureCompatibilityVersion: latestFCV});

    // Enable pre-/post-images for the collection with "recordPreImages" enabled.
    assert.commandWorked(
        testDB.runCommand({"collMod": collName, "changeStreamPreAndPostImages": {enabled: true}}));

    // 'changeStreamPreAndPostImages' option must be enabled and 'recordPreImages' option must be
    // absent.
    assertChangeStreamPreAndPostImagesCollectionOptionIsEnabled(testDB, collName);
    assertCollectionOptionIsAbsent(testDB, collName, "recordPreImages");

    // Downgrade the FCV.
    testDB.adminCommand({setFeatureCompatibilityVersion: downgradeFCV});

    // Downgrading the cluster should fail, since unsupported option 'changeStreamPreAndPostImages'
    // is enabled for the collection.
    try {
        rst.upgradeSet({binVersion: downgradeVersion});
        assert(false);
    } catch (exception) {
        assert.eq(exception.returnCode, MongoRunner.EXIT_UNCAUGHT);
    }

    rst.stopSet();
}

runFeatureFlagMultiversionTest('featureFlagChangeStreamPreAndPostImages', runTest);
})();
