// Rate Selection Component
// Two tabs: Simple Matrix View and Power User View

import React, { useState } from 'react';

// ============================================
// Types
// ============================================

type PackageSize = 'envelope' | 'small' | 'medium' | 'large';
type ShippingSpeed = 'overnight' | 'fast' | 'standard' | 'economy';

interface ShippingRate {
  id: string;
  carrier: string; // 'USPS', 'UPS', 'FedEx'
  service: string; // 'Priority Mail Express', 'Ground', etc.
  size: PackageSize;
  speed: ShippingSpeed;
  priceCents: number;
  estimatedDays: number;
  weightLimitOz: number;
}

interface PackageSizeConfig {
  id: PackageSize;
  label: string;
  maxWeightOz: number;
  dimensions: string; // display only
  icon: string;
}

// ============================================
// Configuration
// ============================================

const PACKAGE_SIZES: PackageSizeConfig[] = [
  {
    id: 'envelope',
    label: 'Envelope',
    maxWeightOz: 16, // 1 lb
    dimensions: 'Up to 12" × 9"',
    icon: '📄'
  },
  {
    id: 'small',
    label: 'Small Box',
    maxWeightOz: 32, // 2 lbs
    dimensions: '8" × 6" × 4"',
    icon: '📦'
  },
  {
    id: 'medium',
    label: 'Medium Box',
    maxWeightOz: 96, // 6 lbs
    dimensions: '12" × 9" × 6"',
    icon: '📦'
  },
  {
    id: 'large',
    label: 'Large Box',
    maxWeightOz: 160, // 10 lbs
    dimensions: '18" × 12" × 10"',
    icon: '📦'
  }
];

const SPEED_OPTIONS = [
  { id: 'overnight', label: 'Overnight', days: 1, color: '#FF6B6B' },
  { id: 'fast', label: '2-3 Days', days: 3, color: '#FFA500' },
  { id: 'standard', label: '3-5 Days', days: 5, color: '#00E5CC' },
  { id: 'economy', label: '5-7 Days', days: 7, color: '#9BA3AF' }
];

// ============================================
// Mock Data Generator
// ============================================

function generateMockRates(): ShippingRate[] {
  const rates: ShippingRate[] = [];
  
  const baseRates = {
    envelope: { overnight: 2500, fast: 800, standard: 500, economy: 350 },
    small: { overnight: 3500, fast: 1200, standard: 850, economy: 600 },
    medium: { overnight: 4500, fast: 1800, standard: 1250, economy: 900 },
    large: { overnight: 6500, fast: 2500, standard: 1800, economy: 1300 }
  };
  
  PACKAGE_SIZES.forEach(size => {
    SPEED_OPTIONS.forEach(speed => {
      const basePriceCents = baseRates[size.id][speed.id];
      
      // USPS
      rates.push({
        id: `usps-${size.id}-${speed.id}`,
        carrier: 'USPS',
        service: speed.id === 'overnight' ? 'Priority Mail Express' : 
                 speed.id === 'fast' ? 'Priority Mail' : 
                 speed.id === 'standard' ? 'Ground Advantage' : 
                 'Parcel Select',
        size: size.id,
        speed: speed.id as ShippingSpeed,
        priceCents: basePriceCents,
        estimatedDays: speed.days,
        weightLimitOz: size.maxWeightOz
      });
      
      // UPS (slightly more expensive, not available for envelopes on economy)
      if (!(size.id === 'envelope' && speed.id === 'economy')) {
        rates.push({
          id: `ups-${size.id}-${speed.id}`,
          carrier: 'UPS',
          service: speed.id === 'overnight' ? 'Next Day Air' : 
                   speed.id === 'fast' ? '2nd Day Air' : 
                   speed.id === 'standard' ? 'Ground' : 
                   'SurePost',
          size: size.id,
          speed: speed.id as ShippingSpeed,
          priceCents: Math.round(basePriceCents * 1.15),
          estimatedDays: speed.days,
          weightLimitOz: size.maxWeightOz
        });
      }
      
      // FedEx (premium pricing)
      if (speed.id !== 'economy') {
        rates.push({
          id: `fedex-${size.id}-${speed.id}`,
          carrier: 'FedEx',
          service: speed.id === 'overnight' ? 'Priority Overnight' : 
                   speed.id === 'fast' ? '2Day' : 
                   'Home Delivery',
          size: size.id,
          speed: speed.id as ShippingSpeed,
          priceCents: Math.round(basePriceCents * 1.25),
          estimatedDays: speed.days,
          weightLimitOz: size.maxWeightOz
        });
      }
    });
  });
  
  return rates;
}

// ============================================
// Component
// ============================================

export function RateSelector() {
  const [activeTab, setActiveTab] = useState<'matrix' | 'power'>('matrix');
  const [selectedRate, setSelectedRate] = useState<ShippingRate | null>(null);
  const [estimatedWeightOz, setEstimatedWeightOz] = useState<number>(16);
  
  const allRates = generateMockRates();
  
  // Filter rates by estimated weight
  const availableRates = allRates.filter(rate => rate.weightLimitOz >= estimatedWeightOz);
  
  // Group rates for matrix view (cheapest rate per size/speed combo)
  function getMatrixRate(size: PackageSize, speed: ShippingSpeed): ShippingRate | undefined {
    const matching = availableRates.filter(r => r.size === size && r.speed === speed);
    return matching.sort((a, b) => a.priceCents - b.priceCents)[0];
  }
  
  return (
    <div style={{ maxWidth: '900px', margin: '0 auto' }}>
      {/* Weight Input */}
      <div style={{ marginBottom: '2rem', padding: '1.5rem', background: '#14192D', borderRadius: '8px' }}>
        <label style={{ display: 'block', marginBottom: '0.5rem', fontWeight: 500 }}>
          Estimated weight
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
          <input 
            type="number"
            value={Math.round(estimatedWeightOz / 16 * 10) / 10}
            onChange={(e) => setEstimatedWeightOz(Math.round(parseFloat(e.target.value) * 16))}
            step="0.1"
            min="0.1"
            max="10"
            style={{
              padding: '0.75rem',
              background: '#1A1F3A',
              border: '1px solid #2A3144',
              borderRadius: '6px',
              color: '#E8EAED',
              width: '100px',
              fontSize: '1rem'
            }}
          />
          <span style={{ color: '#9BA3AF' }}>lbs</span>
          <span style={{ color: '#9BA3AF', fontSize: '0.875rem', marginLeft: '1rem' }}>
            ({estimatedWeightOz} oz)
          </span>
        </div>
      </div>
      
      {/* Tab Selector */}
      <div style={{ 
        display: 'flex', 
        gap: '0.5rem', 
        marginBottom: '2rem',
        borderBottom: '1px solid #2A3144'
      }}>
        <button
          onClick={() => setActiveTab('matrix')}
          style={{
            padding: '1rem 2rem',
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'matrix' ? '2px solid #00E5CC' : '2px solid transparent',
            color: activeTab === 'matrix' ? '#00E5CC' : '#9BA3AF',
            fontWeight: activeTab === 'matrix' ? 600 : 400,
            cursor: 'pointer',
            fontSize: '0.95rem'
          }}
        >
          Simple Chooser
        </button>
        <button
          onClick={() => setActiveTab('power')}
          style={{
            padding: '1rem 2rem',
            background: 'transparent',
            border: 'none',
            borderBottom: activeTab === 'power' ? '2px solid #00E5CC' : '2px solid transparent',
            color: activeTab === 'power' ? '#00E5CC' : '#9BA3AF',
            fontWeight: activeTab === 'power' ? 600 : 400,
            cursor: 'pointer',
            fontSize: '0.95rem'
          }}
        >
          Power Chooser
        </button>
      </div>
      
      {/* Matrix View */}
      {activeTab === 'matrix' && (
        <div>
          <p style={{ marginBottom: '1.5rem', color: '#9BA3AF', fontSize: '0.875rem' }}>
            Pick a size and speed to see the best price (estimated)
          </p>
          
          <div style={{ 
            display: 'grid',
            gridTemplateColumns: 'auto repeat(4, 1fr)',
            gap: '0.5rem'
          }}>
            {/* Header row */}
            <div></div>
            {SPEED_OPTIONS.map(speed => (
              <div 
                key={speed.id}
                style={{
                  padding: '0.75rem',
                  textAlign: 'center',
                  fontSize: '0.875rem',
                  fontWeight: 600,
                  color: '#E8EAED'
                }}
              >
                <div>{speed.label}</div>
                <div style={{ fontSize: '0.75rem', color: '#9BA3AF', marginTop: '0.25rem' }}>
                  ~{speed.days} {speed.days === 1 ? 'day' : 'days'}
                </div>
              </div>
            ))}
            
            {/* Size rows */}
            {PACKAGE_SIZES.map(size => (
              <React.Fragment key={size.id}>
                <div style={{
                  padding: '1rem',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'center',
                  fontSize: '0.875rem'
                }}>
                  <div style={{ fontWeight: 600, marginBottom: '0.25rem' }}>
                    {size.icon} {size.label}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#9BA3AF' }}>
                    {size.dimensions}
                  </div>
                  <div style={{ fontSize: '0.75rem', color: '#9BA3AF' }}>
                    Max: {size.maxWeightOz / 16} lbs
                  </div>
                </div>
                
                {SPEED_OPTIONS.map(speed => {
                  const rate = getMatrixRate(size.id, speed.id as ShippingSpeed);
                  const isDisabled = !rate || rate.weightLimitOz < estimatedWeightOz;
                  const isSelected = selectedRate?.id === rate?.id;
                  
                  return (
                    <button
                      key={`${size.id}-${speed.id}`}
                      disabled={isDisabled}
                      onClick={() => rate && setSelectedRate(rate)}
                      style={{
                        padding: '1rem',
                        background: isSelected ? 'rgba(0, 229, 204, 0.1)' : 
                                    isDisabled ? '#0A0E27' : '#14192D',
                        border: isSelected ? '2px solid #00E5CC' : '1px solid #2A3144',
                        borderRadius: '8px',
                        cursor: isDisabled ? 'not-allowed' : 'pointer',
                        transition: 'all 0.2s',
                        opacity: isDisabled ? 0.4 : 1
                      }}
                    >
                      {rate ? (
                        <>
                          <div style={{ 
                            fontSize: '1.25rem', 
                            fontWeight: 700, 
                            color: '#E8EAED',
                            marginBottom: '0.25rem'
                          }}>
                            ${(rate.priceCents / 100).toFixed(2)}
                          </div>
                          <div style={{ fontSize: '0.75rem', color: '#9BA3AF' }}>
                            {rate.carrier}
                          </div>
                        </>
                      ) : (
                        <div style={{ fontSize: '0.875rem', color: '#9BA3AF' }}>
                          —
                        </div>
                      )}
                    </button>
                  );
                })}
              </React.Fragment>
            ))}
          </div>
          
          <p style={{ 
            marginTop: '1rem', 
            fontSize: '0.75rem', 
            color: '#9BA3AF',
            fontStyle: 'italic'
          }}>
            💡 Prices shown are estimates. Actual cost may vary based on exact dimensions and weight.
          </p>
        </div>
      )}
      
      {/* Power User View */}
      {activeTab === 'power' && (
        <div>
          <p style={{ marginBottom: '1.5rem', color: '#9BA3AF', fontSize: '0.875rem' }}>
            All available shipping options sorted by price
          </p>
          
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
            {availableRates
              .sort((a, b) => a.priceCents - b.priceCents)
              .map(rate => {
                const isSelected = selectedRate?.id === rate.id;
                const speedOption = SPEED_OPTIONS.find(s => s.id === rate.speed);
                
                return (
                  <button
                    key={rate.id}
                    onClick={() => setSelectedRate(rate)}
                    style={{
                      padding: '1.25rem',
                      background: isSelected ? 'rgba(0, 229, 204, 0.1)' : '#14192D',
                      border: isSelected ? '2px solid #00E5CC' : '1px solid #2A3144',
                      borderRadius: '8px',
                      cursor: 'pointer',
                      textAlign: 'left',
                      transition: 'all 0.2s',
                      display: 'grid',
                      gridTemplateColumns: '1fr auto auto',
                      alignItems: 'center',
                      gap: '1.5rem'
                    }}
                  >
                    <div>
                      <div style={{ 
                        fontWeight: 600, 
                        marginBottom: '0.25rem',
                        fontSize: '0.95rem',
                        color: '#E8EAED'
                      }}>
                        {rate.carrier} {rate.service}
                      </div>
                      <div style={{ fontSize: '0.875rem', color: '#9BA3AF' }}>
                        {PACKAGE_SIZES.find(s => s.id === rate.size)?.label} • 
                        {speedOption?.label} delivery ({rate.estimatedDays} {rate.estimatedDays === 1 ? 'day' : 'days'})
                      </div>
                    </div>
                    
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '0.75rem', color: '#9BA3AF' }}>
                        Max weight
                      </div>
                      <div style={{ fontSize: '0.875rem', fontWeight: 500, color: '#E8EAED' }}>
                        {rate.weightLimitOz / 16} lbs
                      </div>
                    </div>
                    
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '0.75rem', color: '#9BA3AF' }}>
                        Estimated cost
                      </div>
                      <div style={{ fontSize: '1.5rem', fontWeight: 700, color: '#00E5CC' }}>
                        ${(rate.priceCents / 100).toFixed(2)}
                      </div>
                    </div>
                  </button>
                );
              })}
          </div>
        </div>
      )}
      
      {/* Selected Rate Summary */}
      {selectedRate && (
        <div style={{ 
          marginTop: '2rem', 
          padding: '1.5rem', 
          background: 'rgba(0, 229, 204, 0.05)',
          border: '1px solid rgba(0, 229, 204, 0.2)',
          borderRadius: '8px'
        }}>
          <div style={{ fontWeight: 600, marginBottom: '1rem', color: '#E8EAED' }}>
            Selected shipping option:
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '1rem' }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#9BA3AF', marginBottom: '0.25rem' }}>
                Carrier
              </div>
              <div style={{ fontSize: '0.95rem', color: '#E8EAED' }}>
                {selectedRate.carrier} {selectedRate.service}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#9BA3AF', marginBottom: '0.25rem' }}>
                Delivery
              </div>
              <div style={{ fontSize: '0.95rem', color: '#E8EAED' }}>
                {selectedRate.estimatedDays} business {selectedRate.estimatedDays === 1 ? 'day' : 'days'}
              </div>
            </div>
            <div>
              <div style={{ fontSize: '0.75rem', color: '#9BA3AF', marginBottom: '0.25rem' }}>
                Estimated cost
              </div>
              <div style={{ fontSize: '1.25rem', fontWeight: 700, color: '#00E5CC' }}>
                ${(selectedRate.priceCents / 100).toFixed(2)}
              </div>
            </div>
          </div>
          
          <div style={{ 
            marginTop: '1rem', 
            padding: '0.75rem', 
            background: 'rgba(255, 165, 0, 0.1)',
            borderRadius: '6px',
            fontSize: '0.875rem',
            color: '#FFA500'
          }}>
            💡 This is an <strong>estimated</strong> cost based on the package size you selected. 
            The actual cost will be calculated when the sender confirms the exact dimensions and weight.
          </div>
        </div>
      )}
    </div>
  );
}
