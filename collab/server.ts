import { resolve } from 'node:path';
import { defaultDatabasePath, initializeDatabase, openDatabase } from './database.js';
import { GitRepository } from './git.js';
import { createCollaborationHttpServer } from './http.js';
import { CollaborationService } from './service.js';

const host = '127.0.0.1';
const port = Number(process.env['PORT'] ?? 4173);
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('PORT must be an integer from 1 to 65535');

const repository = GitRepository.discover();
const db = openDatabase(defaultDatabasePath(repository.binding.rootPath));
initializeDatabase(db, repository.binding, repository.headCommit());
const service = new CollaborationService(db, repository);
const server = createCollaborationHttpServer(service, resolve(repository.binding.rootPath, 'dist'));

server.listen(port, host, () => {
  process.stdout.write(`SCRAPGRID listening on http://${host}:${port}\n`);
});

function shutdown(): void {
  server.close(() => {
    db.close();
    process.exit(0);
  });
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
