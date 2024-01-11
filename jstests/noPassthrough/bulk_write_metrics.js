/**
 * Test that bulkWrite emit the same metrics that corresponding calls to update, delete and insert.
 *
 * @tags: [featureFlagBulkWriteCommand] // TODO SERVER-52419: Remove this tag.
 */

import {BulkWriteMetricChecker} from "jstests/libs/bulk_write_utils.js";

function runTest(isMongos, cluster, bulkWrite, retryCount, timeseries) {
    // We are ok with the randomness here since we clearly log the state.
    const errorsOnly = Math.random() < 0.5;
    print(`Running on a ${isMongos ? "ShardingTest" : "ReplSetTest"} with bulkWrite = ${
        bulkWrite}, errorsOnly = ${errorsOnly} and timeseries = ${timeseries}.`);

    const dbName = "testDB";
    const collName = "testColl";
    const namespace = `${dbName}.${collName}`;
    const session = isMongos ? cluster.s.startSession() : cluster.getPrimary().startSession();
    const testDB = session.getDatabase(dbName);

    // The chunks below are [$minKey, key1) on shard0, [key1, key2) on shard1 and [key2, $maxKey) on
    // shard2.
    const key0 = ISODate("2024-01-02T00:00:00.00Z");  // On shard0.
    const key1 = ISODate("2024-01-05T00:00:00.00Z");  // On shard1.
    const key2 = ISODate("2024-01-20T00:00:00.00Z");  // On shard2.

    if (timeseries) {
        assert.commandWorked(testDB.createCollection(collName, {
            timeseries: {timeField: "timestamp", bucketMaxSpanSeconds: 1, bucketRoundingSeconds: 1}
        }));
    }

    if (isMongos) {
        assert.commandWorked(testDB.adminCommand({'enableSharding': dbName}));

        assert.commandWorked(
            testDB.adminCommand({shardCollection: namespace, key: {timestamp: 1}}));

        const splitNs = timeseries ? `${dbName}.system.buckets.${collName}` : namespace;
        const splitKey = timeseries ? "control.min.timestamp" : "timestamp";

        assert.commandWorked(testDB.adminCommand({split: splitNs, middle: {[splitKey]: key1}}));
        assert.commandWorked(testDB.adminCommand({split: splitNs, middle: {[splitKey]: key2}}));

        // Move chunks so each shard has one chunk.
        assert.commandWorked(testDB.adminCommand({
            moveChunk: splitNs,
            find: {[splitKey]: key0},
            to: cluster.shard0.shardName,
            _waitForDelete: true
        }));
        assert.commandWorked(testDB.adminCommand({
            moveChunk: splitNs,
            find: {[splitKey]: key1},
            to: cluster.shard1.shardName,
            _waitForDelete: true
        }));
        assert.commandWorked(testDB.adminCommand({
            moveChunk: splitNs,
            find: {[splitKey]: key2},
            to: cluster.shard2.shardName,
            _waitForDelete: true
        }));
    }

    const coll = testDB[collName];

    const metricChecker =
        new BulkWriteMetricChecker(testDB,
                                   namespace,
                                   bulkWrite,
                                   isMongos,
                                   false /*fle*/,
                                   errorsOnly,
                                   retryCount,
                                   timeseries,
                                   ISODate("2021-05-18T00:00:00.000Z") /* defaultTimestamp */);

    // Simplifies implementation of checkBulkWriteMetrics:
    // totals["testDB.testColl"] will not be undefined on first top call below.
    metricChecker.executeCommand({insert: collName, documents: [{_id: 99}]});

    metricChecker.checkMetrics("Simple insert",
                               [{insert: 0, document: {_id: 0}}],
                               [{insert: collName, documents: [{_id: 0}]}],
                               {inserted: 1});

    metricChecker.checkMetrics("Update with pipeline",
                               [{update: 0, filter: {_id: 0}, updateMods: [{$set: {x: 1}}]}],
                               [{update: collName, updates: [{q: {_id: 0}, u: [{$set: {x: 1}}]}]}],
                               {updated: 1, updatePipeline: 1});

    metricChecker.executeCommand(
        {insert: collName, documents: [{_id: 1, a: [{b: 5}, {b: 1}, {b: 2}]}]});

    metricChecker.checkMetrics(
        "Update with arrayFilters",
        [{
            update: 0,
            filter: {_id: 1},
            updateMods: {$set: {"a.$[i].b": 6}},
            arrayFilters: [{"i.b": 5}]
        }],
        [{
            update: collName,
            updates: [{q: {_id: 1}, u: {$set: {"a.$[i].b": 6}}, arrayFilters: [{"i.b": 5}]}]
        }],
        {updated: 1, updateArrayFilters: 1});

    metricChecker.checkMetrics("Simple delete",
                               [{delete: 0, filter: {_id: 0}}],
                               [{delete: collName, deletes: [{q: {_id: 0}, limit: 1}]}],
                               {deleted: 1});

    metricChecker.checkMetricsWithRetries("Simple insert with retry",
                                          [{insert: 0, document: {_id: 3}}],
                                          {
                                              insert: collName,
                                              documents: [{_id: 3}],
                                          },
                                          {inserted: 1, retriedInsert: retryCount - 1},
                                          session.getSessionId(),
                                          NumberLong(10));

    metricChecker.checkMetricsWithRetries(
        "Simple update with retry",
        [{
            update: 0,
            filter: {_id: 1},
            updateMods: {$set: {"a.$[i].b": 7}},
            arrayFilters: [{"i.b": 6}]
        }],
        {
            update: collName,
            updates: [{q: {_id: 1}, u: {$set: {"a.$[i].b": 7}}, arrayFilters: [{"i.b": 6}]}]
        },
        {
            updated: 1,
            updateArrayFilters: retryCount  // This is incremented even on a retry.
        },
        session.getSessionId(),
        NumberLong(11));

    // This one is set to have the 2 oneShard updates (each on a different shard) and 3 oneShard
    // inserts (each on a different shard). This means that the bulkWrite as a whole counts as 1 in
    // update.manyShards and 1 in insert.allShards.
    let insertShardField = bulkWrite ? "allShards" : "oneShard";
    let updateShardField = bulkWrite || timeseries ? "manyShards" : "oneShard";

    const key3 = ISODate("2024-01-10T00:00:00.00Z");  // On shard1.
    const key4 = ISODate("2024-01-30T00:00:00.00Z");  // On shard2.

    metricChecker.checkMetrics(
        "Multiple operations",
        [
            {insert: 0, document: {_id: 4, timestamp: key0}},
            {update: 0, filter: {timestamp: key0}, updateMods: {$set: {x: 2}}},
            {insert: 0, document: {timestamp: key3}},
            {update: 0, filter: {timestamp: key3}, updateMods: {$set: {x: 2}}},
            {insert: 0, document: {timestamp: key4}},
            {delete: 0, filter: {_id: 4, timestamp: key0}}
        ],
        [
            {insert: collName, documents: [{_id: 4, timestamp: key0}]},
            {update: collName, updates: [{q: {timestamp: key0}, u: {$set: {x: 2}}}]},
            {insert: collName, documents: [{timestamp: key3}]},
            {update: collName, updates: [{q: {timestamp: key3}, u: {$set: {x: 2}}}]},
            {insert: collName, documents: [{timestamp: key4}]},
            {delete: collName, deletes: [{q: {_id: 4, timestamp: key0}, limit: 1}]}
        ],
        {
            updated: 2,
            inserted: 3,
            deleted: 1,
            singleUpdateForBulkWrite: true,
            singleInsertForBulkWrite: true,
            insertShardField: insertShardField,
            updateShardField: updateShardField,
            deleteShardField: "oneShard"
        });

    if (isMongos) {
        // Update modifying owning shard requires a transaction or retryable write, we do not want
        // actual retries here.
        metricChecker.retryCount = 1;
        metricChecker.checkMetricsWithRetries(
            "Update modifying owning shard",
            [
                {update: 0, filter: {timestamp: key3}, updateMods: {$set: {timestamp: key4}}},
            ],
            {update: collName, updates: [{q: {timestamp: key3}, u: {$set: {timestamp: key4}}}]},
            {updated: 1, updateShardField: "manyShards"},
            session.getSessionId(),
            NumberLong(12));
    }

    coll.drop();
}

{
    const testName = jsTestName();
    const replTest = new ReplSetTest({
        name: testName,
        nodes: [{}, {rsConfig: {priority: 0}}],
        nodeOptions: {
            setParameter: {
                // Required for serverStatus() to have opWriteConcernCounters.
                reportOpWriteConcernCountersInServerStatus: true
            }
        }
    });

    replTest.startSet();
    replTest.initiateWithHighElectionTimeout();

    const retryCount = 3;
    for (const bulkWrite of [false, true]) {
        for (const timeseries of [false, true]) {
            runTest(false /* isMongos */, replTest, bulkWrite, retryCount, timeseries);
        }
    }

    replTest.stopSet();
}

{
    const st = new ShardingTest({mongos: 1, shards: 3, rs: {nodes: 1}, config: 1});

    const retryCount = 3;
    for (const bulkWrite of [false, true]) {
        for (const timeseries of [false, true]) {
            runTest(true /* isMongos */, st, bulkWrite, retryCount, timeseries);
        }
    }

    st.stop();
}
