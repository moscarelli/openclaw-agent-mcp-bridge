import assert from "node:assert/strict";
import test from "node:test";
import { Semaphore } from "../src/lib/concurrency.mjs";
import { isToolError, ERROR_CATEGORIES } from "../src/lib/errors.mjs";

test("semaphore enforces the max concurrency", async () => {
  const sem = new Semaphore(2);
  const r1 = await sem.acquire();
  const r2 = await sem.acquire();
  assert.equal(sem.active, 2);
  // A terceira aquisição não resolve enquanto não houver release.
  let acquiredThird = false;
  const p3 = sem.acquire(1000).then((r) => {
    acquiredThird = true;
    return r;
  });
  // Cede o event loop sem criar um timer que o mantenha vivo artificialmente.
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(acquiredThird, false);
  r1();
  const r3 = await p3;
  assert.equal(acquiredThird, true);
  r2();
  r3();
  assert.equal(sem.active, 0);
});

test("semaphore rejects with busy on acquire timeout (deterministic, no keep-alive)", async () => {
  const sem = new Semaphore(1);
  const r1 = await sem.acquire();
  // A rejeição por timeout deve ocorrer mesmo sendo o único trabalho pendente:
  // não há nenhum timer/handle auxiliar mantendo o event loop vivo aqui.
  await assert.rejects(
    () => sem.acquire(20),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.BUSY,
  );
  // A vaga do titular ainda é dele; active permanece 1 até o release.
  assert.equal(sem.active, 1);
  r1();
  assert.equal(sem.active, 0);
});

test("acquisition succeeds after a release frees a slot", async () => {
  const sem = new Semaphore(1);
  const r1 = await sem.acquire();
  const p2 = sem.acquire(1000);
  await Promise.resolve();
  r1(); // libera a vaga → p2 deve resolver
  const r2 = await p2;
  assert.equal(sem.active, 1);
  r2();
  assert.equal(sem.active, 0);
});

test("an expired waiter is removed from the queue", async () => {
  const sem = new Semaphore(1);
  const r1 = await sem.acquire();
  await assert.rejects(
    () => sem.acquire(20),
    (err) => isToolError(err) && err.category === ERROR_CATEGORIES.BUSY,
  );
  // Após a expiração, a fila não deve reter o waiter: um release não pode
  // "acordar" ninguém e active volta a 0 (sem vaga presa).
  r1();
  assert.equal(sem.active, 0);
  // E uma nova aquisição imediata deve conseguir a vaga livre.
  const r2 = await sem.acquire(50);
  assert.equal(sem.active, 1);
  r2();
  assert.equal(sem.active, 0);
});

test("release after expiration never hands a slot to the expired waiter", async () => {
  const sem = new Semaphore(1);
  const r1 = await sem.acquire();

  // Waiter que vai expirar (timeout curto).
  const expired = sem.acquire(20);
  await assert.rejects(expired, (err) => isToolError(err) && err.category === ERROR_CATEGORIES.BUSY);

  // Um segundo waiter entra DEPOIS que o primeiro já expirou.
  const fresh = sem.acquire(1000);
  await Promise.resolve();

  // O release deve entregar a vaga ao waiter válido (fresh), nunca ao expirado.
  r1();
  const rFresh = await fresh;
  assert.equal(sem.active, 1);
  rFresh();
  assert.equal(sem.active, 0);
});

test("multiple waiters are served in FIFO order", async () => {
  const sem = new Semaphore(1);
  const r1 = await sem.acquire();

  const order = [];
  const w1 = sem.acquire(1000).then((r) => {
    order.push(1);
    return r;
  });
  const w2 = sem.acquire(1000).then((r) => {
    order.push(2);
    return r;
  });
  const w3 = sem.acquire(1000).then((r) => {
    order.push(3);
    return r;
  });
  await Promise.resolve();

  // Cada release libera o próximo na ordem de entrada.
  r1();
  const rw1 = await w1;
  rw1();
  const rw2 = await w2;
  rw2();
  const rw3 = await w3;
  rw3();

  assert.deepEqual(order, [1, 2, 3]);
  assert.equal(sem.active, 0);
});

test("release is idempotent", async () => {
  const sem = new Semaphore(2);
  const r1 = await sem.acquire();
  await sem.acquire();
  assert.equal(sem.active, 2);
  r1();
  assert.equal(sem.active, 1);
  // Chamar o mesmo release de novo não deve alterar active nem liberar vagas extras.
  r1();
  r1();
  assert.equal(sem.active, 1);
});
