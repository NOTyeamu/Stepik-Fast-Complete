using System;

class Program
{
    static void Main()
    {
        long chislo = long.Parse(Console.ReadLine());

        while (chislo > 0)
        {
            long cifra = chislo % 10;

            if (cifra % 2 != 0)
            {
                Console.Write(cifra);
            }

            chislo = chislo / 10;
        }

        Console.WriteLine();
    }
}