var suffix = uniqueString(resourceGroup().id)
resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: 'iptest${suffix}'
  location: resourceGroup().location
  sku: { name: 'Basic' }
  properties: { adminUserEnabled: false }
}
resource storage 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'iptest${suffix}'
  location: resourceGroup().location
  kind: 'StorageV2'
  sku: { name: 'Standard_LRS' }
  properties: {
    supportsHttpsTrafficOnly: true
    minimumTlsVersion: 'TLS1_2'
    allowBlobPublicAccess: false
    allowCrossTenantReplication: false
  }
}
resource files 'Microsoft.Storage/storageAccounts/fileServices@2023-05-01' existing = { parent: storage, name: 'default' }
resource share 'Microsoft.Storage/storageAccounts/fileServices/shares@2023-05-01' = {
  parent: files
  name: 'checkpoint'
  properties: { shareQuota: 1, enabledProtocols: 'SMB' }
}
resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: 'synthetic-test'
  location: resourceGroup().location
  properties: {
    workloadProfiles: [{ name: 'Consumption', workloadProfileType: 'Consumption' }]
  }
}
resource mount 'Microsoft.App/managedEnvironments/storages@2024-03-01' = {
  parent: env
  name: 'checkpoint'
  properties: {
    azureFile: { accountName: storage.name, accountKey: storage.listKeys().keys[0].value, shareName: share.name, accessMode: 'ReadWrite' }
  }
}
resource runtime 'Microsoft.ManagedIdentity/userAssignedIdentities@2023-01-31' = {
  name: 'test-runtime'
  location: resourceGroup().location
}
resource pull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, runtime.id, 'AcrPull')
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', '7f951dda-4ed3-4680-a7ca-43fe172d538d')
    principalId: runtime.properties.principalId
    principalType: 'ServicePrincipal'
  }
}
output registryName string = registry.name
output host string = 'studio-test.${env.properties.defaultDomain}'
output principalId string = runtime.properties.principalId
