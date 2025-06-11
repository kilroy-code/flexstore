import process from 'process';
import express from 'express';
import logger from 'morgan';
import compression from 'compression';
import flexstoreRouter from '@kilroy-code/flexstore/router';

process.title = 'ki1r0yflex';

const port = 3000;
const app = express();
// It is more efficient to support gzip in a production reverse proxy, but doing it here in development
// so that we're more likely hit any snags now rather than in production.
app.use(compression());
app.use(logger('dev'));
app.use('/flexstore', flexstoreRouter); // Before any json parser.
app.listen(port, () => console.log(`Listening on port ${port}.`));


