import { describe, expect, it } from 'vitest';

import { frameAncestorsDirective } from '../src/http/frame-ancestors.js';

function env(value?: string): NodeJS.ProcessEnv {
  return value === undefined ? {} : { OD_ALLOWED_ORIGINS: value };
}

describe('frameAncestorsDirective', () => {
  it('stays strict when the operator declares no browser origin', () => {
    expect(frameAncestorsDirective(env())).toBe("'self'");
    expect(frameAncestorsDirective(env('   '))).toBe("'self'");
  });

  it('adds every allow-listed origin so a split-origin page may frame previews', () => {
    expect(frameAncestorsDirective(env('https://od.example.com')))
      .toBe("'self' https://od.example.com");
    expect(
      frameAncestorsDirective(env('https://od.example.com, https://staging.od.example.com')),
    ).toBe("'self' https://od.example.com https://staging.od.example.com");
  });

  it('normalizes entries and drops duplicates', () => {
    expect(
      frameAncestorsDirective(env('https://od.example.com/, https://od.example.com')),
    ).toBe("'self' https://od.example.com");
  });

  it('never widens the policy for an unparsable entry', () => {
    expect(frameAncestorsDirective(env('od.example.com'))).toBe("'self'");
    expect(frameAncestorsDirective(env('https://od.example.com,dummy://x'))).toBe("'self'");
  });

  it('never emits a wildcard', () => {
    expect(frameAncestorsDirective(env('https://od.example.com'))).not.toContain('*');
  });
});
