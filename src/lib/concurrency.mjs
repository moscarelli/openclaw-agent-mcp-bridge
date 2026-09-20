// Semáforo para limitar processos filhos simultâneos (PHASE1_PLAN §8).
// Aquisição além do teto aguarda até CONCURRENCY_ACQUIRE_TIMEOUT_MS; se não
// houver vaga, rejeita com ToolError(busy).
//
// Contrato de ciclo de vida do acquire():
//   - uma aquisição pendente com timeout SEMPRE assenta (resolve ou rejeita);
//     por isso o timer de timeout NÃO recebe unref() — o processo não deve
//     encerrar deixando a Promise pendente (evita a falha intermitente
//     "Promise resolution is still pending but the event loop has already
//     resolved");
//   - nenhum timer ou waiter fica pendente após assentar;
//   - um waiter expirado é removido da fila e NUNCA adquire uma vaga depois
//     (o release pula waiters já assentados);
//   - release é idempotente;
//   - a ordem de atendimento dos waiters é FIFO.

import { ToolError, ERROR_CATEGORIES } from "./errors.mjs";
import { MAX_CONCURRENT_CHILDREN, CONCURRENCY_ACQUIRE_TIMEOUT_MS } from "./limits.mjs";

export class Semaphore {
  #max;
  #active = 0;
  #waiters = [];

  constructor(max = MAX_CONCURRENT_CHILDREN) {
    this.#max = Math.max(1, max);
  }

  get active() {
    return this.#active;
  }

  /**
   * Aquisição NÃO-BLOQUEANTE. Se houver vaga, adquire e retorna a função de
   * release; caso contrário retorna `null` IMEDIATAMENTE (sem enfileirar, sem
   * timer, sem waiter). Usada pela ferramenta mutante experimental para
   * responder `busy` na hora, sem esperar o timeout de aquisição. Não afeta a
   * semântica de `acquire()` usada pelas ferramentas read-only.
   *
   * @returns {(() => void) | null}
   */
  tryAcquire() {
    if (this.#active < this.#max) {
      this.#active += 1;
      return this.#makeRelease();
    }
    return null;
  }

  acquire(timeoutMs = CONCURRENCY_ACQUIRE_TIMEOUT_MS) {
    if (this.#active < this.#max) {
      this.#active += 1;
      return Promise.resolve(this.#makeRelease());
    }
    return new Promise((resolve, reject) => {
      const waiter = {
        settled: false,
        timer: null,
        // Chamado quando uma vaga é entregue a este waiter (via release).
        grant: () => {
          if (waiter.settled) return;
          waiter.settled = true;
          if (waiter.timer !== null) clearTimeout(waiter.timer);
          waiter.timer = null;
          this.#active += 1;
          resolve(this.#makeRelease());
        },
      };

      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        waiter.timer = null;
        const idx = this.#waiters.indexOf(waiter);
        if (idx !== -1) this.#waiters.splice(idx, 1);
        reject(new ToolError(ERROR_CATEGORIES.BUSY, "Concurrency limit reached"));
      }, timeoutMs);
      // Intencionalmente SEM unref(): a rejeição por timeout precisa ocorrer
      // mesmo que esta Promise seja o único trabalho pendente no event loop.

      this.#waiters.push(waiter);
    });
  }

  #makeRelease() {
    let released = false;
    return () => {
      if (released) return; // idempotente
      released = true;
      this.#active -= 1;
      // Entrega a vaga ao próximo waiter FIFO que ainda não assentou.
      // Waiters expirados (settled) são descartados, nunca recebem a vaga.
      while (this.#waiters.length > 0) {
        const next = this.#waiters.shift();
        if (next && !next.settled) {
          next.grant();
          break;
        }
      }
    };
  }
}

// Semáforo compartilhado do bridge.
export const childProcessSemaphore = new Semaphore();
