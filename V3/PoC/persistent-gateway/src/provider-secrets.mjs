const PROVIDERS = {
  deepseek: {
    secretEnv: 'DEEPSEEK_API_KEY',
    baseUrlEnv: 'DEEPSEEK_BASE_URL',
    defaultBaseUrl: 'https://api.deepseek.com',
  },
  zhipu: {
    secretEnv: 'ZHIPU_CODING_TOKEN',
    baseUrlEnv: 'ZHIPU_CODING_BASE_URL',
  },
  kimi: {
    secretEnv: 'KIMI_CODING_TOKEN',
    baseUrlEnv: 'KIMI_CODING_BASE_URL',
  },
};

class SecretValue {
  #value;

  constructor(value) {
    this.#value = value;
  }

  reveal() {
    return this.#value;
  }

  toJSON() {
    return '[REDACTED]';
  }

  toString() {
    return '[REDACTED]';
  }
}

export function loadProviderConnection(name, env = process.env) {
  const definition = PROVIDERS[name];
  if (!definition) throw new Error(`Unsupported provider: ${name}`);
  const rawSecret = env[definition.secretEnv];
  const baseUrl = env[definition.baseUrlEnv] ?? definition.defaultBaseUrl;
  if (!rawSecret || !baseUrl) {
    return {
      name,
      configured: false,
      secretEnv: definition.secretEnv,
      baseUrlEnv: definition.baseUrlEnv,
    };
  }
  return {
    name,
    configured: true,
    baseUrl,
    secret: new SecretValue(rawSecret),
  };
}

export function providerInjectionStatus(env = process.env) {
  return Object.keys(PROVIDERS).map((name) => {
    const connection = loadProviderConnection(name, env);
    return {
      name,
      configured: connection.configured,
      secretEnv: PROVIDERS[name].secretEnv,
      baseUrlEnv: PROVIDERS[name].baseUrlEnv,
    };
  });
}
