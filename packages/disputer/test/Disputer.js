const {
  PostWithdrawLiquidationRewardsStatusTranslations,
  LiquidationStatesEnum,
  MAX_UINT_VAL
} = require("@umaprotocol/common");
const { interfaceName } = require("@umaprotocol/common");
const winston = require("winston");
const sinon = require("sinon");

const { toWei, toBN, utf8ToHex } = web3.utils;

// Script to test
const { Disputer } = require("../src/disputer.js");

// Helper clients and custom winston transport module to monitor winston log outputs
const {
  ExpiringMultiPartyClient,
  GasEstimator,
  PriceFeedMock,
  SpyTransport
} = require("@umaprotocol/financial-templates-lib");

// Contracts and helpers
const ExpiringMultiParty = artifacts.require("ExpiringMultiParty");
const Finder = artifacts.require("Finder");
const IdentifierWhitelist = artifacts.require("IdentifierWhitelist");
const MockOracle = artifacts.require("MockOracle");
const TokenFactory = artifacts.require("TokenFactory");
const Token = artifacts.require("ExpandedERC20");
const Timer = artifacts.require("Timer");

contract("Disputer.js", function(accounts) {
  const disputeBot = accounts[0];
  const sponsor1 = accounts[1];
  const sponsor2 = accounts[2];
  const sponsor3 = accounts[3];
  const liquidator = accounts[4];
  const contractCreator = accounts[5];
  const rando = accounts[6];

  let collateralToken;
  let emp;
  let syntheticToken;
  let mockOracle;

  let spy;
  let spyLogger;
  let priceFeedMock;

  let disputerConfig;
  let empProps;

  const zeroAddress = "0x0000000000000000000000000000000000000000";
  const unreachableDeadline = MAX_UINT_VAL;

  before(async function() {
    collateralToken = await Token.new("DAI", "DAI", 18, { from: contractCreator });
    await collateralToken.addMember(1, contractCreator, {
      from: contractCreator
    });

    // Seed the accounts.
    await collateralToken.mint(sponsor1, toWei("100000"), { from: contractCreator });
    await collateralToken.mint(sponsor2, toWei("100000"), { from: contractCreator });
    await collateralToken.mint(sponsor3, toWei("100000"), { from: contractCreator });
    await collateralToken.mint(liquidator, toWei("100000"), { from: contractCreator });
    await collateralToken.mint(disputeBot, toWei("100000"), { from: contractCreator });
  });

  beforeEach(async function() {
    // Create a mockOracle and finder. Register the mockMoracle with the finder.
    finder = await Finder.deployed();
    mockOracle = await MockOracle.new(finder.address, Timer.address, {
      from: contractCreator
    });
    const mockOracleInterfaceName = web3.utils.utf8ToHex(interfaceName.Oracle);
    await finder.changeImplementationAddress(mockOracleInterfaceName, mockOracle.address);

    const constructorParams = {
      expirationTimestamp: "12345678900",
      withdrawalLiveness: "1000",
      collateralAddress: collateralToken.address,
      finderAddress: Finder.address,
      tokenFactoryAddress: TokenFactory.address,
      priceFeedIdentifier: utf8ToHex("UMATEST"),
      syntheticName: "Test UMA Token",
      syntheticSymbol: "UMATEST",
      liquidationLiveness: "1000",
      collateralRequirement: { rawValue: toWei("1.2") },
      disputeBondPct: { rawValue: toWei("0.1") },
      sponsorDisputeRewardPct: { rawValue: toWei("0.1") },
      disputerDisputeRewardPct: { rawValue: toWei("0.1") },
      minSponsorTokens: { rawValue: toWei("1") },
      timerAddress: Timer.address
    };

    identifierWhitelist = await IdentifierWhitelist.deployed();
    await identifierWhitelist.addSupportedIdentifier(constructorParams.priceFeedIdentifier, {
      from: accounts[0]
    });

    // Deploy a new expiring multi party
    emp = await ExpiringMultiParty.new(constructorParams);

    // Generate EMP properties to inform bot of important on-chain state values that we only want to query once.
    empProps = {
      priceIdentifier: await emp.priceIdentifier()
    };

    await collateralToken.approve(emp.address, toWei("100000000"), { from: sponsor1 });
    await collateralToken.approve(emp.address, toWei("100000000"), { from: sponsor2 });
    await collateralToken.approve(emp.address, toWei("100000000"), { from: sponsor3 });
    await collateralToken.approve(emp.address, toWei("100000000"), { from: liquidator });
    await collateralToken.approve(emp.address, toWei("100000000"), { from: disputeBot });

    syntheticToken = await Token.at(await emp.tokenCurrency());
    await syntheticToken.approve(emp.address, toWei("100000000"), { from: sponsor1 });
    await syntheticToken.approve(emp.address, toWei("100000000"), { from: sponsor2 });
    await syntheticToken.approve(emp.address, toWei("100000000"), { from: sponsor3 });
    await syntheticToken.approve(emp.address, toWei("100000000"), { from: liquidator });
    await syntheticToken.approve(emp.address, toWei("100000000"), { from: disputeBot });

    spy = sinon.spy();

    spyLogger = winston.createLogger({
      level: "info",
      transports: [new SpyTransport({ level: "info" }, { spy: spy })]
    });

    // Create a new instance of the ExpiringMultiPartyClient & GasEstimator to construct the disputer
    empClient = new ExpiringMultiPartyClient(spyLogger, ExpiringMultiParty.abi, web3, emp.address);
    gasEstimator = new GasEstimator(spyLogger);

    // Create a new instance of the disputer to test
    disputerConfig = {
      disputeDelay: 0
    };

    // Create price feed mock.
    priceFeedMock = new PriceFeedMock();

    disputer = new Disputer({
      logger: spyLogger,
      expiringMultiPartyClient: empClient,
      votingContract: mockOracle,
      gasEstimator,
      priceFeed: priceFeedMock,
      account: accounts[0],
      empProps,
      config: disputerConfig
    });
  });

  it("Detect disputable positions and send disputes", async function() {
    // sponsor1 creates a position with 125 units of collateral, creating 100 synthetic tokens.
    await emp.create({ rawValue: toWei("125") }, { rawValue: toWei("100") }, { from: sponsor1 });

    // sponsor2 creates a position with 150 units of collateral, creating 100 synthetic tokens.
    await emp.create({ rawValue: toWei("150") }, { rawValue: toWei("100") }, { from: sponsor2 });

    // sponsor3 creates a position with 175 units of collateral, creating 100 synthetic tokens.
    await emp.create({ rawValue: toWei("175") }, { rawValue: toWei("100") }, { from: sponsor3 });

    // The liquidator creates a position to have synthetic tokens.
    await emp.create({ rawValue: toWei("1000") }, { rawValue: toWei("500") }, { from: liquidator });

    await emp.createLiquidation(
      sponsor1,
      { rawValue: "0" },
      { rawValue: toWei("1.75") },
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: liquidator }
    );
    await emp.createLiquidation(
      sponsor2,
      { rawValue: "0" },
      { rawValue: toWei("1.75") },
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: liquidator }
    );
    await emp.createLiquidation(
      sponsor3,
      { rawValue: "0" },
      { rawValue: toWei("1.75") },
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: liquidator }
    );

    // Try disputing before any mocked prices are set, simulating a situation where the pricefeed
    // fails to return a price. The disputer should emit a "warn" level log about each missing prices.
    await disputer.update();
    await disputer.dispute();
    assert.equal(spy.callCount, 3); // 3 warn level logs should be sent for 3 missing prices

    // Start with a mocked price of 1.75 usd per token.
    // This makes all sponsors undercollateralized, meaning no disputes are issued.
    priceFeedMock.setHistoricalPrice(toBN(toWei("1.75")));
    await disputer.update();
    await disputer.dispute();

    // There should be no liquidations created from any sponsor account
    assert.equal((await emp.getLiquidations(sponsor1))[0].state, LiquidationStatesEnum.PRE_DISPUTE);
    assert.equal((await emp.getLiquidations(sponsor2))[0].state, LiquidationStatesEnum.PRE_DISPUTE);
    assert.equal((await emp.getLiquidations(sponsor3))[0].state, LiquidationStatesEnum.PRE_DISPUTE);
    assert.equal(spy.callCount, 3); // No info level logs should be sent.

    // With a price of 1.1, two sponsors should be correctly collateralized, so disputes should be issued against sponsor2 and sponsor3's liquidations.
    priceFeedMock.setHistoricalPrice(toBN(toWei("1.1")));
    await disputer.update();
    await disputer.dispute();
    assert.equal(spy.callCount, 5); // 2 info level logs should be sent at the conclusion of the disputes.

    // Sponsor2 and sponsor3 should be disputed.
    assert.equal((await emp.getLiquidations(sponsor1))[0].state, LiquidationStatesEnum.PRE_DISPUTE);
    assert.equal((await emp.getLiquidations(sponsor2))[0].state, LiquidationStatesEnum.PENDING_DISPUTE);
    assert.equal((await emp.getLiquidations(sponsor3))[0].state, LiquidationStatesEnum.PENDING_DISPUTE);

    // The disputeBot should be the disputer in sponsor2 and sponsor3's liquidations.
    assert.equal((await emp.getLiquidations(sponsor2))[0].disputer, disputeBot);
    assert.equal((await emp.getLiquidations(sponsor3))[0].disputer, disputeBot);
  });

  it("Detect disputable withdraws and send disputes", async function() {
    // sponsor1 creates a position with 125 units of collateral, creating 100 synthetic tokens.
    await emp.create({ rawValue: toWei("125") }, { rawValue: toWei("100") }, { from: sponsor1 });

    // The liquidator creates a position to have synthetic tokens.
    await emp.create({ rawValue: toWei("1000") }, { rawValue: toWei("500") }, { from: liquidator });

    // The sponsor1 submits a valid withdrawal request of withdrawing exactly 5e18 collateral. This places their
    // position at collateral of 120 and debt of 100. At a price of 1 unit per token they are exactly collateralized.

    await emp.requestWithdrawal({ rawValue: toWei("5") }, { from: sponsor1 });

    await emp.createLiquidation(
      sponsor1,
      { rawValue: "0" },
      { rawValue: toWei("1.75") }, // Price high enough to initiate the liquidation
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: liquidator }
    );

    // With a price of 1 usd per token this withdrawal was actually valid, even though it's very close to liquidation.
    // This makes all sponsors undercollateralized, meaning no disputes are issued.
    priceFeedMock.setHistoricalPrice(toBN(toWei("1")));
    await disputer.update();
    await disputer.dispute();
    assert.equal(spy.callCount, 1); // 1 info level logs should be sent at the conclusion of the disputes.

    // Sponsor1 should be disputed.
    assert.equal((await emp.getLiquidations(sponsor1))[0].state, LiquidationStatesEnum.PENDING_DISPUTE);

    // The disputeBot should be the disputer in sponsor1  liquidations.
    assert.equal((await emp.getLiquidations(sponsor1))[0].disputer, disputeBot);

    // Push a price of 1, which should cause sponsor1's dispute to succeed as the position is correctly collateralized
    // at a price of 1.
    const liquidationTime = await emp.getCurrentTime();
    await mockOracle.pushPrice(web3.utils.utf8ToHex("UMATEST"), liquidationTime, toWei("1"));

    await disputer.update();
    await disputer.withdrawRewards();
    assert.equal(spy.callCount, 2); // One additional info level event for the successful withdrawal.

    // sponsor1's dispute should be successful (valid withdrawal)
    assert.equal((await emp.getLiquidations(sponsor1))[0].state, LiquidationStatesEnum.DISPUTE_SUCCEEDED);
  });

  it("Withdraw from successful disputes", async function() {
    // sponsor1 creates a position with 150 units of collateral, creating 100 synthetic tokens.
    await emp.create({ rawValue: toWei("150") }, { rawValue: toWei("100") }, { from: sponsor1 });

    // sponsor2 creates a position with 175 units of collateral, creating 100 synthetic tokens.
    await emp.create({ rawValue: toWei("175") }, { rawValue: toWei("100") }, { from: sponsor2 });

    // The liquidator creates a position to have synthetic tokens.
    await emp.create({ rawValue: toWei("1000") }, { rawValue: toWei("500") }, { from: liquidator });

    await emp.createLiquidation(
      sponsor1,
      { rawValue: "0" },
      { rawValue: toWei("1.75") },
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: liquidator }
    );

    await emp.createLiquidation(
      sponsor2,
      { rawValue: "0" },
      { rawValue: toWei("1.75") },
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: liquidator }
    );

    // With a price of 1.1, the sponsors should be correctly collateralized, so disputes should be issued against sponsor1 and sponsor2's liquidations.
    priceFeedMock.setHistoricalPrice(toBN(toWei("1.1")));
    await disputer.update();
    await disputer.dispute();
    assert.equal(spy.callCount, 2); // Two info level events for the two disputes.

    // Before the dispute is resolved, the bot should simulate the withdrawal, determine that it will fail, and
    // continue to wait.
    await disputer.update();
    await disputer.withdrawRewards();

    // No new info or error logs should appear because no attempted withdrawal should be made.
    assert.equal(spy.callCount, 2);

    // Push a price of 1.3, which should cause sponsor1's dispute to fail and sponsor2's dispute to succeed.
    const liquidationTime = await emp.getCurrentTime();
    await mockOracle.pushPrice(web3.utils.utf8ToHex("UMATEST"), liquidationTime, toWei("1.3"));

    await disputer.update();
    await disputer.withdrawRewards();
    assert.equal(spy.callCount, 3); // One additional info level event for the successful withdrawal.

    // sponsor1's dispute was unsuccessful, so the disputeBot should not have called the withdraw method.
    assert.equal((await emp.getLiquidations(sponsor1))[0].disputer, disputeBot);
    assert.equal((await emp.getLiquidations(sponsor1))[0].state, LiquidationStatesEnum.PENDING_DISPUTE);

    // sponsor2's dispute was successful, so the disputeBot should've called the withdraw method.
    assert.equal((await emp.getLiquidations(sponsor2))[0].disputer, zeroAddress);
    assert.equal((await emp.getLiquidations(sponsor2))[0].state, LiquidationStatesEnum.DISPUTE_SUCCEEDED);

    // Check that the log includes a human readable translation of the liquidation status, and the dispute price.
    assert.equal(
      spy.getCall(-1).lastArg.liquidationResult.liquidationStatus,
      PostWithdrawLiquidationRewardsStatusTranslations[LiquidationStatesEnum.DISPUTE_SUCCEEDED]
    );
    assert.equal(spy.getCall(-1).lastArg.liquidationResult.resolvedPrice, toWei("1.3"));

    // After the dispute is resolved, the liquidation should still exist but the disputer should no longer be able to withdraw any rewards.
    await disputer.update();
    await disputer.withdrawRewards();
    assert.equal(spy.callCount, 3);
  });

  it("Too little collateral", async function() {
    // sponsor1 creates a position with 150 units of collateral, creating 100 synthetic tokens.
    await emp.create({ rawValue: toWei("150") }, { rawValue: toWei("100") }, { from: sponsor1 });

    // sponsor2 creates a position with 1.75 units of collateral, creating 1 synthetic tokens.
    await emp.create({ rawValue: toWei("1.75") }, { rawValue: toWei("1") }, { from: sponsor2 });

    // The liquidator creates a position to have synthetic tokens.
    await emp.create({ rawValue: toWei("1000") }, { rawValue: toWei("500") }, { from: liquidator });

    await emp.createLiquidation(
      sponsor1,
      { rawValue: "0" },
      { rawValue: toWei("1.75") },
      { rawValue: toWei("100") },
      unreachableDeadline,
      { from: liquidator }
    );

    await emp.createLiquidation(
      sponsor2,
      { rawValue: "0" },
      { rawValue: toWei("1.75") },
      { rawValue: toWei("1") },
      unreachableDeadline,
      { from: liquidator }
    );

    // Send most of the user's balance elsewhere leaving only enough to dispute sponsor1's position.
    const transferAmount = (await collateralToken.balanceOf(disputeBot)).sub(toBN(toWei("1")));
    await collateralToken.transfer(rando, transferAmount, { from: disputeBot });

    // Both positions should be disputed with a presumed price of 1.1, but will only have enough collateral for the smaller one.
    priceFeedMock.setHistoricalPrice(toBN(toWei("1.1")));
    await disputer.update();
    await disputer.dispute();
    assert.equal(spy.callCount, 2); // Two info events for the the 1 successful dispute and one for the failed dispute.

    // Only sponsor2 should be disputed.
    assert.equal((await emp.getLiquidations(sponsor1))[0].state, LiquidationStatesEnum.PRE_DISPUTE);
    assert.equal((await emp.getLiquidations(sponsor2))[0].state, LiquidationStatesEnum.PENDING_DISPUTE);

    // Transfer balance back, and the dispute should go through.
    await collateralToken.transfer(disputeBot, transferAmount, { from: rando });
    priceFeedMock.setHistoricalPrice(toBN(toWei("1.1")));
    await disputer.update();
    await disputer.dispute();
    assert.equal(spy.callCount, 3); // Info level event for the correctly processed dispute.

    // sponsor1 should now be disputed.
    assert.equal((await emp.getLiquidations(sponsor1))[0].state, LiquidationStatesEnum.PENDING_DISPUTE);
  });

  describe("Overrides the default disputer configuration settings", function() {
    it("Cannot set `disputeDelay` < 0", async function() {
      let errorThrown;
      try {
        disputerConfig = {
          disputeDelay: -1
        };
        disputer = new Disputer({
          logger: spyLogger,
          expiringMultiPartyClient: empClient,
          votingContract: mockOracle,
          gasEstimator,
          priceFeed: priceFeedMock,
          account: accounts[0],
          empProps,
          config: disputerConfig
        });
        errorThrown = false;
      } catch (err) {
        errorThrown = true;
      }
      assert.isTrue(errorThrown);
    });

    it("Sets `disputeDelay` to 60 seconds", async function() {
      disputerConfig = {
        disputeDelay: 60
      };
      disputer = new Disputer({
        logger: spyLogger,
        expiringMultiPartyClient: empClient,
        votingContract: mockOracle,
        gasEstimator,
        priceFeed: priceFeedMock,
        account: accounts[0],
        empProps,
        config: disputerConfig
      });

      // sponsor1 creates a position with 150 units of collateral, creating 100 synthetic tokens.
      await emp.create({ rawValue: toWei("150") }, { rawValue: toWei("100") }, { from: sponsor1 });

      // The liquidator creates a position to have synthetic tokens.
      await emp.create({ rawValue: toWei("1000") }, { rawValue: toWei("500") }, { from: liquidator });

      await emp.createLiquidation(
        sponsor1,
        { rawValue: "0" },
        { rawValue: toWei("1.75") },
        { rawValue: toWei("100") },
        unreachableDeadline,
        { from: liquidator }
      );
      const liquidationTime = await emp.getCurrentTime();

      // With a price of 1.1, sponsor1 should be correctly collateralized, so a dispute should be issued. However,
      // not enough time has passed since the liquidation timestamp, so we'll delay disputing for now. The
      // `disputeDelay` configuration enforces that we must wait `disputeDelay` seconds after the liquidation
      // timestamp before disputing.
      priceFeedMock.setHistoricalPrice(toBN(toWei("1.1")));
      await disputer.update();
      await disputer.dispute();
      assert.equal(spy.callCount, 0);

      // Sponsor1 should not be disputed.
      assert.equal((await emp.getLiquidations(sponsor1))[0].state, LiquidationStatesEnum.PRE_DISPUTE);

      // Advance contract time and attempt to dispute again.
      await emp.setCurrentTime(Number(liquidationTime) + disputerConfig.disputeDelay);

      priceFeedMock.setHistoricalPrice(toBN(toWei("1.1")));
      await disputer.update();
      await disputer.dispute();
      assert.equal(spy.callCount, 1);

      // The disputeBot should be the disputer in sponsor1's liquidations.
      assert.equal((await emp.getLiquidations(sponsor1))[0].state, LiquidationStatesEnum.PENDING_DISPUTE);
      assert.equal((await emp.getLiquidations(sponsor1))[0].disputer, disputeBot);
    });

    it("Can provide an override price to disputer", async function() {
      // sponsor1 creates a position with 130 units of collateral, creating 100 synthetic tokens.
      await emp.create({ rawValue: toWei("130") }, { rawValue: toWei("100") }, { from: sponsor1 });

      // The liquidator creates a position to have synthetic tokens.
      await emp.create({ rawValue: toWei("1000") }, { rawValue: toWei("500") }, { from: liquidator });

      // The sponsor1 submits a valid withdrawal request of withdrawing 5e18 collateral. This places their
      // position at collateral of 125 and debt of 100.
      await emp.requestWithdrawal({ rawValue: toWei("5") }, { from: sponsor1 });

      // Next, we will create an invalid liquidation to liquidate the whole position.
      await emp.createLiquidation(
        sponsor1,
        { rawValue: "0" },
        { rawValue: toWei("1.75") }, // Price high enough to initiate the liquidation
        { rawValue: toWei("100") },
        unreachableDeadline,
        { from: liquidator }
      );

      // Say the price feed reports a price of 1 USD per token. This makes the liquidation invalid and the disputer should
      // dispute the liquidation: 125/(100*1.0)=1.25 CR -> Position was collateralized and invalid liquidation.
      priceFeedMock.setHistoricalPrice(toBN(toWei("1")));

      // However, say disputer operator has provided an override price of 1.2 USD per token. This makes the liquidation
      // valid and the disputer should do nothing: 125/(100*1.2)=1.0
      await disputer.update();
      await disputer.dispute(toWei("1.2"));
      assert.equal(spy.callCount, 0); // 0 info level logs should be sent as no dispute.
      assert.equal((await emp.getLiquidations(sponsor1))[0].state, LiquidationStatesEnum.PRE_DISPUTE);

      // Next assume that the override price is in fact 1 USD per token. At this price point the liquidation is now
      // invalid that the disputer should try dispute the tx.
      await disputer.update();
      await disputer.dispute(toWei("1.0"));
      assert.equal(spy.callCount, 1); // 1 info level logs should be sent for the dispute
      assert.equal((await emp.getLiquidations(sponsor1))[0].state, LiquidationStatesEnum.PENDING_DISPUTE);

      // The disputeBot should be the disputer in sponsor1  liquidations.
      assert.equal((await emp.getLiquidations(sponsor1))[0].disputer, disputeBot);
    });
  });
});
