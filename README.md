# HOPR Liquidity Mining Program

## HOPR net

HOPR is a privacy-preserving messaging protocol that incentivizes users to participate in the network. It provides privacy by relaying messages via several relay nodes to the recipient. Relay nodes are getting paid via payment channels for their services.

## HOPR farm

The winning Genesis DAO proposal for the HOPR launch instructed that 5 million HOPR tokens should be reserved as liquidity mining incentives for Uniswap. 


### Installation

- Set node version
    ```
    nvm use
    ```
    
- Install packages 
    ```
    yarn
    ```

- Compile contracts
    ```
    yarn build
    ```
- Test contracts
    ```
    yarn test
    ```
- Test coverage
    ```
    yarn coverage
    ```

### Status

Current code coverage is 
```
|---------------------|----------|----------|----------|----------|
| File                |  % Stmts | % Branch |  % Funcs |  % Lines |
|---------------------|----------|----------|----------|----------|
|  contracts/         |    74.68 |    47.22 |    68.75 |    76.25 |
|   HoprFarm.sol      |    74.68 |    47.22 |    68.75 |    76.25 |
|---------------------|----------|----------|----------|----------|
```