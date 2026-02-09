(() => {
  if (window.__consoleCopyHelperInstalled) {
    return;
  }
  window.__consoleCopyHelperInstalled = true;

  const EVENT_NAME = '__CONSOLE_CAPTURE_EVENT__';
  const LOG_LIMIT = 5000;
  const logs = [];
  const wrappedMethods = ['log', 'info', 'warn', 'error', 'debug'];

  function toSerializable(value, seen = new WeakSet()) {
    if (value === null || value === undefined) {
      return value;
    }

    const valueType = typeof value;

    if (
      valueType === 'string' ||
      valueType === 'number' ||
      valueType === 'boolean'
    ) {
      return value;
    }

    if (valueType === 'bigint') {
      return `${value.toString()}n`;
    }

    if (valueType === 'symbol') {
      return value.toString();
    }

    if (valueType === 'function') {
      return `[Function ${value.name || 'anonymous'}]`;
    }

    if (value instanceof Error) {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack || null,
      };
    }

    if (value instanceof Date) {
      return value.toISOString();
    }

    if (seen.has(value)) {
      return '[Circular]';
    }

    if (Array.isArray(value)) {
      seen.add(value);
      return value.map((item) => toSerializable(item, seen));
    }

    if (valueType === 'object') {
      seen.add(value);
      const output = {};
      for (const [key, nestedValue] of Object.entries(value)) {
        output[key] = toSerializable(nestedValue, seen);
      }
      return output;
    }

    return String(value);
  }

  function emit(level, args, source = 'console') {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      source,
      args: args.map((arg) => toSerializable(arg)),
    };

    logs.push(entry);
    if (logs.length > LOG_LIMIT) {
      logs.shift();
    }

    window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: entry }));
  }

  for (const methodName of wrappedMethods) {
    const original = console[methodName];
    if (typeof original !== 'function') {
      continue;
    }

    console[methodName] = function wrappedConsoleMethod(...args) {
      emit(methodName, args);
      return original.apply(this, args);
    };
  }

  window.addEventListener('error', (event) => {
    emit(
      'error',
      [
        {
          message: event.message,
          file: event.filename,
          line: event.lineno,
          column: event.colno,
          stack: event.error && event.error.stack ? event.error.stack : null,
        },
      ],
      'window.error'
    );
  });

  window.addEventListener('unhandledrejection', (event) => {
    emit('error', [event.reason], 'unhandledrejection');
  });
})();
