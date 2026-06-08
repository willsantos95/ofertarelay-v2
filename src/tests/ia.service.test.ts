/**
 * Testes do serviço de IA (ia.service.ts)
 * Foca em: chamada correta à OpenAI, safeguards de link/preço,
 * tratamento de erros e fallback do link.
 */

// Não depende do express — testamos a função diretamente
process.env.OPENAI_API_KEY = 'sk-test-key';

import { iaConfigurada, melhorarLegendaIA } from '../services/ia.service';

const CTX_SHOPEE = {
  nome:        'Fone JBL Tune 520BT',
  preco:       'R$ 189,90',
  plataforma:  'shopee',
  link:        'https://s.shopee.com.br/abc123',
  descontoPct: 25,
};

const CTX_ML = {
  nome:        'Notebook Acer i5',
  preco:       'R$ 2.499,00',
  plataforma:  'mercadolivre',
  link:        'https://meli.la/xyzabc',
  descontoPct: null,
};

/* ══════════════════════════════════════════════════════ */
describe('IA Service', () => {
  beforeEach(() => jest.clearAllMocks());

  /* ── iaConfigurada ── */
  describe('iaConfigurada()', () => {
    test('retorna true quando OPENAI_API_KEY está definida', () => {
      expect(iaConfigurada()).toBe(true);
    });

    test('retorna false quando OPENAI_API_KEY está ausente', () => {
      const backup = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;
      expect(iaConfigurada()).toBe(false);
      process.env.OPENAI_API_KEY = backup;
    });
  });

  /* ── melhorarLegendaIA ── */
  describe('melhorarLegendaIA()', () => {
    test('lança erro se OPENAI_API_KEY não configurada', async () => {
      const backup = process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_API_KEY;

      await expect(
        melhorarLegendaIA('Legenda teste', CTX_SHOPEE)
      ).rejects.toThrow('IA não configurada');

      process.env.OPENAI_API_KEY = backup;
    });

    test('chama a API OpenAI com o modelo correto (padrão gpt-4o-mini)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '🔥 Fone JBL por R$ 189,90! https://s.shopee.com.br/abc123' } }],
        }),
      }) as jest.Mock;

      await melhorarLegendaIA('Fone JBL 189,90 https://s.shopee.com.br/abc123', CTX_SHOPEE);

      const fetchCall = (global.fetch as jest.Mock).mock.calls[0];
      const body = JSON.parse(fetchCall[1].body);
      expect(body.model).toBe('gpt-4o-mini');
    });

    test('usa modelo customizado se OPENAI_MODEL definido', async () => {
      process.env.OPENAI_MODEL = 'gpt-4o';
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'Legenda https://s.shopee.com.br/abc123' } }],
        }),
      }) as jest.Mock;

      await melhorarLegendaIA('Legenda', CTX_SHOPEE);

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.model).toBe('gpt-4o');
      delete process.env.OPENAI_MODEL;
    });

    test('retorna texto da resposta da OpenAI', async () => {
      const textoEsperado = '🎧 Corre! Fone JBL só hoje por *R$ 189,90*! https://s.shopee.com.br/abc123';
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: textoEsperado } }],
        }),
      }) as jest.Mock;

      const resultado = await melhorarLegendaIA('Fone JBL 189,90', CTX_SHOPEE);
      expect(resultado).toBe(textoEsperado);
    });

    test('remove aspas ao redor do texto se IA as adicionar', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '"Fone JBL R$ 189,90 https://s.shopee.com.br/abc123"' } }],
        }),
      }) as jest.Mock;

      const resultado = await melhorarLegendaIA('Legenda', CTX_SHOPEE);
      expect(resultado.startsWith('"')).toBe(false);
      expect(resultado.endsWith('"')).toBe(false);
    });

    test('remove backticks ao redor do texto', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: '`Legenda com backtick https://s.shopee.com.br/abc123`' } }],
        }),
      }) as jest.Mock;

      const resultado = await melhorarLegendaIA('Legenda', CTX_SHOPEE);
      expect(resultado.startsWith('`')).toBe(false);
    });

    test('reinsere o link se a IA o remover', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: 'Fone JBL R$ 189,90 — oferta imperdível!' } }],
          // nota: SEM o link na resposta
        }),
      }) as jest.Mock;

      const resultado = await melhorarLegendaIA('Legenda', CTX_SHOPEE);
      expect(resultado).toContain(CTX_SHOPEE.link);
    });

    test('não duplica link se já estiver presente', async () => {
      const textoComLink = `🔥 Fone JBL! *R$ 189,90* ${CTX_SHOPEE.link}`;
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: textoComLink } }],
        }),
      }) as jest.Mock;

      const resultado = await melhorarLegendaIA('Legenda', CTX_SHOPEE);
      const ocorrencias = resultado.split(CTX_SHOPEE.link).length - 1;
      expect(ocorrencias).toBe(1); // link aparece exatamente uma vez
    });

    test('inclui dados do contexto no prompt (nome, preço, plataforma, link)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: `Legenda ${CTX_SHOPEE.link}` } }],
        }),
      }) as jest.Mock;

      await melhorarLegendaIA('Legenda base', CTX_SHOPEE);

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      const userContent = body.messages[1].content;
      expect(userContent).toContain(CTX_SHOPEE.nome);
      expect(userContent).toContain(String(CTX_SHOPEE.preco));
      expect(userContent).toContain(CTX_SHOPEE.link);
      expect(userContent).toContain('shopee');
    });

    test('inclui desconto no prompt quando presente', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: `Legenda ${CTX_SHOPEE.link}` } }],
        }),
      }) as jest.Mock;

      await melhorarLegendaIA('Legenda', CTX_SHOPEE);

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      const userContent = body.messages[1].content;
      expect(userContent).toContain('25'); // descontoPct
      expect(userContent).toContain('OFF');
    });

    test('não inclui linha de desconto quando descontoPct é null', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: `Notebook ${CTX_ML.link}` } }],
        }),
      }) as jest.Mock;

      await melhorarLegendaIA('Legenda', CTX_ML);

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      const userContent = body.messages[1].content;
      expect(userContent).not.toContain('% OFF');
    });

    test('system prompt inclui instrução de linguagem coloquial', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: `Legenda ${CTX_SHOPEE.link}` } }],
        }),
      }) as jest.Mock;

      await melhorarLegendaIA('Legenda', CTX_SHOPEE);

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      const sysContent = body.messages[0].content;
      expect(sysContent).toContain('informal');
    });

    test('system prompt instrui manter link intacto', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: `Legenda ${CTX_SHOPEE.link}` } }],
        }),
      }) as jest.Mock;

      await melhorarLegendaIA('Legenda', CTX_SHOPEE);

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      const sysContent = body.messages[0].content;
      expect(sysContent.toLowerCase()).toContain('link');
      expect(sysContent.toLowerCase()).toContain('mantenha');
    });

    test('lança erro quando OpenAI retorna status 4xx', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 401,
        text: () => Promise.resolve('{"error":{"message":"Invalid API key"}}'),
      }) as jest.Mock;

      await expect(
        melhorarLegendaIA('Legenda', CTX_SHOPEE)
      ).rejects.toThrow('OpenAI 401');
    });

    test('lança erro quando OpenAI retorna status 429 (rate limit)', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 429,
        text: () => Promise.resolve('{"error":{"message":"Rate limit exceeded"}}'),
      }) as jest.Mock;

      await expect(
        melhorarLegendaIA('Legenda', CTX_SHOPEE)
      ).rejects.toThrow('OpenAI 429');
    });

    test('lança erro quando choices está vazio na resposta', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ choices: [] }),
      }) as jest.Mock;

      await expect(
        melhorarLegendaIA('Legenda', CTX_SHOPEE)
      ).rejects.toThrow();
    });

    test('lança erro quando content é null na resposta', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: null } }],
        }),
      }) as jest.Mock;

      await expect(
        melhorarLegendaIA('Legenda', CTX_SHOPEE)
      ).rejects.toThrow();
    });

    test('max_tokens = 400 na chamada', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: `Legenda ${CTX_SHOPEE.link}` } }],
        }),
      }) as jest.Mock;

      await melhorarLegendaIA('Legenda', CTX_SHOPEE);

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.max_tokens).toBe(400);
    });

    test('temperature = 0.8 na chamada', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({
          choices: [{ message: { content: `Legenda ${CTX_SHOPEE.link}` } }],
        }),
      }) as jest.Mock;

      await melhorarLegendaIA('Legenda', CTX_SHOPEE);

      const body = JSON.parse((global.fetch as jest.Mock).mock.calls[0][1].body);
      expect(body.temperature).toBe(0.8);
    });
  });
});
