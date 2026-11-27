@description('Verified default GitHub OIDC subject with the main-only private-test environment.')
param subject string
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' existing = { name: 'iptest${uniqueString(resourceGroup().id)}' }
resource ci 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'test-publisher'
  location: resourceGroup().location
}
resource federation 'Microsoft.ManagedIdentity/userAssignedIdentities/federatedIdentityCredentials@2023-01-31' = {
  parent: ci
  name: 'main-environment'
  properties: { issuer: 'https://token.actions.githubusercontent.com', subject: subject, audiences: ['api://AzureADTokenExchange'] }
}
resource push 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, ci.id, 'AcrPush')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '8311e382-0749-4cb8-b61a-304f252e45ec')
    principalId: ci.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
output clientId string = ci.properties.clientId
