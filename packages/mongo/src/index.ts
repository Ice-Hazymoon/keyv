import EventEmitter from 'events';
import {Buffer} from 'buffer';
import {MongoClient as mongoClient, GridFSBucket, type WithId, type Document} from 'mongodb';
import pify from 'pify';
import {type StoredData} from 'keyv';
import {
	type ClearExpiredOutput,
	type ClearOutput,
	type ClearUnusedForOutput, type DeleteManyOutput,
	type DeleteOutput,
	type GetManyOutput,
	type GetOutput, type HasOutput,
	type KeyvMongoConnect,
	type KeyvMongoOptions,
	type Options,
	type PifyFunction, type SetOutput,
} from './types';

const keyvMongoKeys = new Set(['url', 'collection', 'namespace', 'serialize', 'deserialize', 'uri', 'useGridFS', 'dialect']);
class KeyvMongo<Value = any> extends EventEmitter {
	ttlSupport = false;
	opts: Options;
	connect: Promise<KeyvMongoConnect>;
	namespace?: string;

	constructor(url?: KeyvMongoOptions, options?: Options) {
		super();
		url = url ?? {};
		if (typeof url === 'string') {
			url = {url};
		}

		if (url.uri) {
			url = {url: url.uri, ...url};
		}

		this.opts = {
			url: 'mongodb://127.0.0.1:27017',
			collection: 'keyv',
			...url,
			...options,
		};

		const mongoOptions = Object.fromEntries(
			Object.entries(this.opts).filter(
				([k]) => !keyvMongoKeys.has(k),
			),
		);

		this.opts = Object.fromEntries(
			Object.entries(this.opts).filter(
				([k]) => keyvMongoKeys.has(k),
			),
		);

		// Implementation from sql by lukechilds,
		this.connect = new Promise(resolve => {
			mongoClient.connect(this.opts.url!, mongoOptions, (error, client) => {
				if (error) {
					return this.emit('error', error);
				}

				const db = client!.db(this.opts.db);

				if (this.opts.useGridFS) {
					const bucket = new GridFSBucket(db, {
						readPreference: this.opts.readPreference,
						bucketName: this.opts.collection,
					});
					const store = db.collection(`${this.opts.collection!}.files`);
					store.createIndex({
						filename: 'hashed',
					});
					store.createIndex({
						uploadDate: -1,
					});
					store.createIndex({
						'metadata.expiresAt': 1,
					});
					store.createIndex({
						'metadata.lastAccessed': 1,
					});

					for (const method of [
						'updateOne',
						'count',
					]) {
						// @ts-expect-error - method needs to be a string
						store[method] = pify(store[method].bind(store) as PifyFunction);
					}

					for (const method of [
						'find',
						'drop',
					]) {
						// @ts-expect-error - method needs to be a string
						bucket[method] = pify(bucket[method].bind(bucket) as PifyFunction);
					}

					resolve({bucket, store, db});
				} else {
					const store = db.collection(this.opts.collection!);
					store.createIndex(
						{key: 1},
						{
							unique: true,
							background: true,
						},
					);
					store.createIndex(
						{expiresAt: 1},
						{
							expireAfterSeconds: 0,
							background: true,
						},
					);

					for (const method of [
						'updateOne',
						'findOne',
						'deleteOne',
						'deleteMany',
						'count',
					]) {
						// @ts-expect-error - method needs to be a string
						store[method] = pify(store[method].bind(store) as PifyFunction);
					}

					resolve({store});
				}
			});
		});
	}

	async get(key: string): GetOutput<Value> {
		if (this.opts.useGridFS) {
			const client = await this.connect;
			await client.store.updateOne({
				filename: key,
			}, {
				$set: {
					'metadata.lastAccessed': new Date(),
				},
			});

			const stream = client.bucket!.openDownloadStreamByName(key);

			return new Promise(resolve => {
				const resp: Uint8Array[] = [];
				stream.on('error', () => {
					resolve(undefined);
				});

				stream.on('end', () => {
					const data = Buffer.concat(resp).toString('utf8');
					resolve(data as Value);
				});

				stream.on('data', chunk => {
					resp.push(chunk as Uint8Array);
				});
			});
		}

		const connect = await this.connect;
		const doc = await connect.store.findOne({key: {$eq: key}});

		if (!doc) {
			return undefined;
		}

		return doc.value as Value;
	}

	async getMany(keys: string[]): GetManyOutput<Value> {
		if (this.opts.useGridFS) {
			const promises = [];
			for (const key of keys) {
				promises.push(this.get(key));
			}

			const values = await Promise.allSettled(promises);
			const data: Array<StoredData<Value>> = [];
			for (const value of values) {
				// @ts-expect-error = value is PromiseFulfilledResult<Value>
				data.push(value.value as StoredData<Value>);
			}

			return data;
		}

		const connect = await this.connect;
		// @ts-expect-error eslint-disable-next-line
		const values: Array<{key: string; value: StoredData<Value>}> = await connect.store.s.db.collection(this.opts.collection!)
			.find({key: {$in: keys}})
			.project({_id: 0, value: 1, key: 1})
			.toArray();

		const results: Array<StoredData<Value>> = [...keys];
		let i = 0;
		for (const key of keys) {
			const rowIndex = values.findIndex((row: {key: string; value: unknown}) => row.key === key);

			results[i] = rowIndex > -1 ? values[rowIndex].value : undefined;

			i++;
		}

		return results;
	}

	async set(key: string, value: Value, ttl?: number): SetOutput {
		const expiresAt = typeof ttl === 'number' ? new Date(Date.now() + ttl) : null;

		if (this.opts.useGridFS) {
			const client = await this.connect;
			const stream = client.bucket!.openUploadStream(key, {
				metadata: {
					expiresAt,
					lastAccessed: new Date(),
				},
			});

			return new Promise(resolve => {
				stream.on('finish', () => {
					resolve(stream);
				});
				stream.end(value as any);
			});
		}

		const client = await this.connect;
		return client.store.updateOne(
			{key: {$eq: key}},
			{$set: {key, value, expiresAt}},
			{upsert: true},
		);
	}

	async delete(key: string): DeleteOutput {
		if (typeof key !== 'string') {
			return false;
		}

		const client = await this.connect;

		if (this.opts.useGridFS) {
			try {
				const connection = client.db!;
				const bucket = new GridFSBucket(connection, {
					bucketName: this.opts.collection,
				});
				const files = await bucket.find({filename: key}).toArray();
				await client.bucket!.delete(files[0]._id);
				return true;
			} catch {
				return false;
			}
		}

		const object = await client.store.deleteOne({key: {$eq: key}});
		return object.deletedCount > 0;
	}

	async deleteMany(keys: string[]): DeleteManyOutput {
		const client = await this.connect;
		if (this.opts.useGridFS) {
			const connection = client.db!;
			const bucket = new GridFSBucket(connection, {
				bucketName: this.opts.collection,
			});
			const files = await bucket.find({filename: {$in: keys}}).toArray();
			if (files.length === 0) {
				return false;
			}

			await Promise.all(files.map(async file => client.bucket!.delete(file._id)));
			return true;
		}

		const object = await client.store.deleteMany({key: {$in: keys}});
		return object.deletedCount > 0;
	}

	async clear(): ClearOutput {
		const client = await this.connect;
		if (this.opts.useGridFS) {
			await client.bucket!.drop();
		}

		await client.store.deleteMany({
			key: {$regex: this.namespace ? `^${this.namespace}:*` : ''},
		});
	}

	async clearExpired(): ClearExpiredOutput {
		if (!this.opts.useGridFS) {
			return false;
		}

		return this.connect.then(async client => {
			const connection = client.db!;
			const bucket = new GridFSBucket(connection, {
				bucketName: this.opts.collection,
			});

			return bucket.find({
				'metadata.expiresAt': {
					$lte: new Date(Date.now()),
				},
			}).toArray()
				.then(async expiredFiles => Promise.all(expiredFiles.map(async file => client.bucket!.delete(file._id))).then(() => true));
		});
	}

	async clearUnusedFor(seconds: number): ClearUnusedForOutput {
		if (!this.opts.useGridFS) {
			return false;
		}

		const client = await this.connect;
		const connection = client.db!;
		const bucket = new GridFSBucket(connection, {
			bucketName: this.opts.collection,
		});

		const lastAccessedFiles = await bucket.find({
			'metadata.lastAccessed': {
				$lte: new Date(Date.now() - (seconds * 1000)),
			},
		}).toArray();

		await Promise.all(lastAccessedFiles.map(async file => client.bucket!.delete(file._id)));
		return true;
	}

	async * iterator(namespace?: string) {
		const client = await this.connect;
		const iterator = client.store
			.find({
				key: new RegExp(`^${namespace ? namespace + ':' : '.*'}`),
			})
			.map((x: WithId<Document>) => [x.key, x.value]);

		yield * iterator;
	}

	async has(key: string): HasOutput {
		const client = await this.connect;
		const filter = {[this.opts.useGridFS ? 'filename' : 'key']: {$eq: key}};
		const doc = await client.store.count(filter);
		return doc !== 0;
	}
}

export = KeyvMongo;
