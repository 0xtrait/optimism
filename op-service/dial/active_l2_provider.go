package dial

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/ethereum-optimism/optimism/op-service/sources"
	"github.com/ethereum/go-ethereum/ethclient"
	"github.com/ethereum/go-ethereum/log"
)

type ActiveL2EndpointProvider struct {
	endpoints      []endpointUrls
	checkDuration  time.Duration
	networkTimeout time.Duration
	log            log.Logger

	idx           int
	activeTimeout time.Time

	currentEthClient    *ethclient.Client
	currentRollupClient *sources.RollupClient
}

type endpointUrls struct {
	ethUrl    string
	rollupUrl string
}

func NewActiveL2EndpointProvider(
	ethUrls, rollupUrls []string,
	checkDuration time.Duration,
	networkTimeout time.Duration,
	logger log.Logger,
) (*ActiveL2EndpointProvider, error) {
	if len(ethUrls) == 0 || len(rollupUrls) == 0 {
		return nil, errors.New("empty urls list")
	}
	if len(ethUrls) != len(rollupUrls) {
		return nil, errors.New("number of eth and rollup urls mismatch")
	}

	n := len(ethUrls)
	eps := make([]endpointUrls, 0, n)
	for i := 0; i < n; i++ {
		eps = append(eps, endpointUrls{
			ethUrl:    ethUrls[0],
			rollupUrl: rollupUrls[0],
		})
	}

	return &ActiveL2EndpointProvider{
		endpoints:      eps,
		checkDuration:  checkDuration,
		networkTimeout: networkTimeout,
		log:            logger,
	}, nil
}

func (p *ActiveL2EndpointProvider) EthClient(ctx context.Context) (*ethclient.Client, error) {
	panic("not implemented") // TODO: Implement
}

func (p *ActiveL2EndpointProvider) RollupClient(ctx context.Context) (*sources.RollupClient, error) {
	panic("not implemented") // TODO: Implement
}

func (p *ActiveL2EndpointProvider) ensureActiveEndpoint(ctx context.Context) error {
	if !p.shouldCheck() {
		return nil
	}

	if err := p.findActiveEndpoints(ctx); err != nil {
		return err
	}
	p.activeTimeout = time.Now().Add(p.checkDuration)
	return nil
}

func (p *ActiveL2EndpointProvider) shouldCheck() bool {
	return time.Now().After(p.activeTimeout)
}

func (p *ActiveL2EndpointProvider) findActiveEndpoints(ctx context.Context) error {
	// If current is not active, dial new sequencers until finding an active one.
	ts := time.Now()
	for i := 0; ; i++ {
		active, err := p.checkCurrentSequencer(ctx)
		if err != nil {
			if ctx.Err() != nil {
				p.log.Warn("Error querying active sequencer, trying next.", "err", err, "try", i)
				return fmt.Errorf("querying active sequencer: %w", err)
			}
			p.log.Warn("Error querying active sequencer, trying next.", "err", err, "try", i)
		} else if active {
			p.log.Debug("Current sequencer active.", "try", i)
			return nil
		} else {
			p.log.Info("Current sequencer inactive, trying next.", "try", i)
		}

		// After iterating over all endpoints, sleep if all were just inactive,
		// to avoid spamming the sequencers in a loop.
		if (i+1)%p.NumEndpoints() == 0 {
			d := ts.Add(p.checkDuration).Sub(time.Now())
			time.Sleep(d) // accepts negative
			ts = time.Now()
		}

		if err := p.dialNextSequencer(ctx); err != nil {
			return fmt.Errorf("dialing next sequencer: %w", err)
		}
	}
}

func (p *ActiveL2EndpointProvider) checkCurrentSequencer(ctx context.Context) (bool, error) {
	cctx, cancel := context.WithTimeout(ctx, p.networkTimeout)
	defer cancel()
	return p.currentRollupClient.SequencerActive(cctx)
}

func (p *ActiveL2EndpointProvider) dialNextSequencer(ctx context.Context, idx int) error {
	cctx, cancel := context.WithTimeout(ctx, p.networkTimeout)
	defer cancel()
	ep := p.endpoints[idx]

	ethClient, err := DialEthClientWithTimeout(cctx, p.networkTimeout, p.log, ep.ethUrl)
	if err != nil {
		return fmt.Errorf("dialing eth client: %w", err)
	}
	rollupClient, err := DialRollupClientWithTimeout(cctx, p.networkTimeout, p.log, ep.rollupUrl)
	if err != nil {
		return fmt.Errorf("dialing rollup client: %w", err)
	}

	p.currentEthClient, p.currentRollupClient = ethClient, rollupClient
	return nil
}

func (p *ActiveL2EndpointProvider) NumEndpoints() int {
	return len(p.endpoints)
}
