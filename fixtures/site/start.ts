import { FIXTURE_CREDENTIALS, startFixture } from "./server.ts";

// Runs the fixture site until interrupted: `npm run fixture` (PORT=8080 npm run fixture for a fixed port).
const fixture = await startFixture({ port: Number(process.env.PORT ?? 0) });
process.stdout.write(
  `Fixture site running at ${fixture.url}\n` +
    `Demo shop at ${fixture.url}/demo\n` +
    `Login: ${FIXTURE_CREDENTIALS.username} / ${FIXTURE_CREDENTIALS.password}\n` +
    `For fixtures/configs/fixture.json:\n` +
    `  export FIXTURE_URL=${fixture.url} FIXTURE_USER=${FIXTURE_CREDENTIALS.username} FIXTURE_PASS=${FIXTURE_CREDENTIALS.password}\n`,
);
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void fixture.close().then(() => process.exit(0));
  });
}
