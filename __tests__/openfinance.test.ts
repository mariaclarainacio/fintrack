import {
  buildRange,
  cleanDescription,
  describeItemProblem,
  mapTransaction,
  suggestCategory,
  toBrazilDate,
} from '../supabase/functions/_shared/openfinance';
import type { PluggyTransaction } from '../supabase/functions/_shared/openfinance';

function tx(partial: Partial<PluggyTransaction> = {}): PluggyTransaction {
  return {
    id: 'tx-1',
    description: 'Compra Mercado Bom Preço',
    currencyCode: 'BRL',
    amount: -45.9,
    date: '2026-09-10T00:00:00.000Z',
    type: 'DEBIT',
    status: 'POSTED',
    ...partial,
  };
}

describe('toBrazilDate', () => {
  it('mantém o dia quando a data vem à meia-noite UTC', () => {
    expect(toBrazilDate('2026-09-10T00:00:00.000Z')).toBe('2026-09-10');
  });

  it('converte para o horário de Brasília quando há hora', () => {
    expect(toBrazilDate('2026-09-10T01:30:00.000Z')).toBe('2026-09-09');
    expect(toBrazilDate('2026-09-10T15:00:00.000Z')).toBe('2026-09-10');
  });

  it('devolve null para datas inválidas', () => {
    expect(toBrazilDate('ontem')).toBeNull();
  });
});

describe('cleanDescription', () => {
  it('normaliza espaços e limita a 80 caracteres', () => {
    expect(cleanDescription(' PIX   ENVIADO ')).toBe('PIX ENVIADO');
    expect(cleanDescription('x'.repeat(200))).toHaveLength(80);
  });

  it('usa um texto padrão quando a descrição é curta demais', () => {
    expect(cleanDescription(' a ')).toBe('Transação bancária');
  });
});

describe('suggestCategory', () => {
  it('prefere a categoria do Pluggy', () => {
    expect(suggestCategory('expense', 'Eating out', 'COMPRA 123')).toBe('Alimentação');
    expect(suggestCategory('expense', 'Health', 'PAGTO 999')).toBe('Saúde');
  });

  it('usa palavras da descrição quando não há categoria', () => {
    expect(suggestCategory('expense', null, 'IFOOD *PEDIDO')).toBe('Alimentação');
    expect(suggestCategory('expense', null, 'Drogaria São Paulo')).toBe('Saúde');
    expect(suggestCategory('expense', undefined, 'NETFLIX.COM')).toBe('Lazer');
    expect(suggestCategory('income', null, 'Salário Setembro')).toBe('Salário');
  });

  it('cai em "Outros" quando nada combina', () => {
    expect(suggestCategory('expense', null, 'XYZ 123')).toBe('Outros');
    expect(suggestCategory('income', 'Transfer', 'TED recebida')).toBe('Outros');
  });

  it('usa as regras certas para cada direção', () => {
    expect(suggestCategory('income', null, 'Rendimentos CDB')).toBe('Investimentos');
    expect(suggestCategory('expense', null, 'Rendimentos CDB')).toBe('Outros');
  });
});

describe('mapTransaction', () => {
  it('converte uma despesa: valor positivo e categoria sugerida', () => {
    const result = mapTransaction(tx(), 'BANK');
    expect(result).toEqual({
      row: {
        external_id: 'tx-1',
        type: 'expense',
        description: 'Compra Mercado Bom Preço',
        amount: 45.9,
        date: '2026-09-10',
        categoryName: 'Alimentação',
      },
    });
  });

  it('converte uma receita usando o campo type', () => {
    const result = mapTransaction(
      tx({ type: 'CREDIT', amount: 3000, description: 'Salário' }),
      'BANK',
    );
    expect(result).toEqual({
      row: {
        external_id: 'tx-1',
        type: 'income',
        description: 'Salário',
        amount: 3000,
        date: '2026-09-10',
        categoryName: 'Salário',
      },
    });
  });

  it('deduz a direção pelo sinal quando não há type', () => {
    const base = { type: undefined, description: 'XYZ 123' };
    // Em conta: positivo é entrada, negativo é saída.
    expect(mapTransaction(tx({ ...base, amount: 100 }), 'BANK')).toMatchObject({
      row: { type: 'income', amount: 100 },
    });
    expect(mapTransaction(tx({ ...base, amount: -100 }), 'BANK')).toMatchObject({
      row: { type: 'expense', amount: 100 },
    });
    // Em cartão: positivo é compra, negativo é estorno.
    expect(mapTransaction(tx({ ...base, amount: 80 }), 'CREDIT')).toMatchObject({
      row: { type: 'expense', amount: 80 },
    });
    expect(mapTransaction(tx({ ...base, amount: -80 }), 'CREDIT')).toMatchObject({
      row: { type: 'income', amount: 80 },
    });
  });

  it('pula pendentes, moeda estrangeira e dados inválidos', () => {
    expect(mapTransaction(tx({ status: 'PENDING' }), 'BANK')).toEqual({
      skip: 'pending',
    });
    expect(mapTransaction(tx({ currencyCode: 'USD' }), 'BANK')).toEqual({
      skip: 'foreign_currency',
    });
    expect(mapTransaction(tx({ amount: 0 }), 'BANK')).toEqual({ skip: 'invalid' });
    expect(mapTransaction(tx({ date: 'ontem' }), 'BANK')).toEqual({ skip: 'invalid' });
    expect(mapTransaction(tx({ id: '' }), 'BANK')).toEqual({ skip: 'invalid' });
  });

  it('ignora o pagamento da fatura na conta, para não contar duas vezes', () => {
    const result = mapTransaction(
      tx({ type: 'DEBIT', description: 'Pagamento de fatura cartão' }),
      'BANK',
    );
    expect(result).toEqual({ skip: 'card_bill_payment' });
  });

  it('ignora o pagamento recebido no cartão', () => {
    const result = mapTransaction(
      tx({ type: 'CREDIT', amount: 500, description: 'Pagamento recebido' }),
      'CREDIT',
    );
    expect(result).toEqual({ skip: 'card_payment_received' });
  });

  it('mantém o estorno no cartão como receita', () => {
    const result = mapTransaction(
      tx({ type: 'CREDIT', amount: 30, description: 'Estorno loja' }),
      'CREDIT',
    );
    expect(result).toMatchObject({ row: { type: 'income', amount: 30 } });
  });
});

describe('buildRange', () => {
  const now = new Date('2026-09-20T12:00:00.000Z');

  it('busca 90 dias na primeira sincronização', () => {
    expect(buildRange(null, now)).toEqual({ from: '2026-06-22', to: '2026-09-20' });
  });

  it('busca desde a última sincronização menos 7 dias', () => {
    expect(buildRange('2026-09-10T00:00:00.000Z', now)).toEqual({
      from: '2026-09-03',
      to: '2026-09-20',
    });
  });

  it('volta aos 90 dias quando a data guardada é inválida', () => {
    expect(buildRange('abc', now)).toEqual({ from: '2026-06-22', to: '2026-09-20' });
  });
});

describe('describeItemProblem', () => {
  it('devolve null quando a conexão está pronta', () => {
    expect(describeItemProblem('UPDATED')).toBeNull();
  });

  it('explica os erros de login', () => {
    expect(describeItemProblem('LOGIN_ERROR', 'USER_AUTHORIZATION_REVOKED')).toEqual({
      message: 'O consentimento foi revogado no banco. Conecte novamente.',
      httpStatus: 422,
    });
    expect(describeItemProblem('LOGIN_ERROR', 'OUTRO_MOTIVO')).toEqual({
      message: 'Não foi possível entrar no banco. Conecte novamente.',
      httpStatus: 422,
    });
  });

  it('trata banco instável e conexão em andamento', () => {
    expect(describeItemProblem('OUTDATED')?.httpStatus).toBe(502);
    expect(describeItemProblem('UPDATING')?.httpStatus).toBe(409);
  });
});
