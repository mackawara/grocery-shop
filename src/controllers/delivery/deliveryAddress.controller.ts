import type { Types } from 'mongoose';
import { logger } from '../../services/logger.ts';
import UserModel from '../../models/User.ts';
import type { IUser } from '../../models/User.ts';
import DeliveryAddressModel from '../../models/DeliveryAddress.ts';

const TAG = '[DELIVERY_ADDRESS]';

export const resolveUserByPhone = async (phoneNumber: string): Promise<IUser> => {
  const existing = await UserModel.findOne({ phoneNumber });
  if (existing) {
    return existing;
  }

  const created = new UserModel({ phoneNumber });
  await created.save();
  logger.info(`${TAG} Created user for ${phoneNumber}`);
  return created;
};

export interface ITypedAddressFields {
  street?: string;
  suburb?: string;
  area?: string;
  town?: string;
}

export const resolveDeliveryAddress = async ({
  userId,
  existingAddressId,
  typed,
}: {
  userId: Types.ObjectId;
  existingAddressId?: Types.ObjectId;
  typed: ITypedAddressFields;
}): Promise<Types.ObjectId> => {
  const typedFields = {
    streetName: typed.street,
    subArea: typed.suburb,
    area: typed.area,
    city: typed.town ?? 'Harare',
  };

  let addressId: Types.ObjectId;

  if (existingAddressId) {
    await DeliveryAddressModel.updateOne({ _id: existingAddressId }, { $set: typedFields });
    addressId = existingAddressId;
  } else {
    const created = await new DeliveryAddressModel({
      user: userId,
      ...typedFields,
    }).save();
    addressId = created._id as Types.ObjectId;
  }

  await UserModel.updateOne({ _id: userId }, { $set: { address: addressId } });

  return addressId;
};
