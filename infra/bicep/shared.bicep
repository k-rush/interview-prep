targetScope = 'resourceGroup'

var suffix = uniqueString(subscription().subscriptionId, toLower(resourceGroup().name))
resource registry 'Microsoft.ContainerRegistry/registries@2025-11-01' = {
  name: 'ip${suffix}'
  location: resourceGroup().location
  sku: { name: 'Basic' }
  properties: {
    adminUserEnabled: false
    roleAssignmentMode: 'LegacyRegistryPermissions'
    policies: {
      azureADAuthenticationAsArmPolicy: { status: 'enabled' }
    }
  }
}

resource store 'Microsoft.Storage/storageAccounts@2023-05-01' = {
  name: 'ipr${suffix}'
  location: resourceGroup().location
  sku: { name: 'Standard_LRS' }
  kind: 'StorageV2'
  properties: {
    allowBlobPublicAccess: false
    allowSharedKeyAccess: false
    minimumTlsVersion: 'TLS1_2'
    supportsHttpsTrafficOnly: true
  }
}
resource blobs 'Microsoft.Storage/storageAccounts/blobServices@2023-05-01' = {
  parent: store
  name: 'default'
  properties: { deleteRetentionPolicy: { enabled: true, days: 30 } }
}
resource containers 'Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01' = [for ring in ['staging', 'production']: {
  parent: blobs
  name: ring
  properties: { publicAccess: 'None' }
}]

output acrName string = registry.name
output storageName string = store.name
