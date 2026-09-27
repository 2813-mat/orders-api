import { simulatedWorkMs } from '../../../../src/orders/processing/simulated-work';

describe('simulatedWorkMs', () => {
  it('stays within [min, max], both ends included', () => {
    expect(simulatedWorkMs(1000, 2000, () => 0)).toBe(1000);
    expect(simulatedWorkMs(1000, 2000, () => 0.999999)).toBe(2000);
    expect(simulatedWorkMs(1000, 2000, () => 0.5)).toBe(1500);
  });

  it('is fixed when min equals max', () => {
    expect(simulatedWorkMs(0, 0)).toBe(0);
  });
});
